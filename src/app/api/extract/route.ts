import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scrapeUrl, findScraper, ScraperError } from '@/lib/scrapers'
import { translateTitles } from '@/lib/translate'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Extraction, Profile } from '@/types/database'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 抽出回数チェック
  const { data: profile } = await supabase
    .from('profiles')
    .select('extraction_limit, extraction_used')
    .eq('id', user.id)
    .single() as { data: Pick<Profile, 'extraction_limit' | 'extraction_used'> | null }

  if (!profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  if (profile.extraction_used >= profile.extraction_limit) {
    return NextResponse.json(
      { error: '抽出回数の上限に達しました。プランをアップグレードしてください。' },
      { status: 429 },
    )
  }

  const body = await req.json()
  const { url, categoryId, sellerAccountId, bulkEditSettingId, memo, isBulk } = body

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'URLが必要です' }, { status: 400 })
  }

  const scraper = findScraper(url)
  if (!scraper) {
    return NextResponse.json(
      { error: 'このURLには対応していません。対応サイト: メルカリ、ヤフオク、ラクマ、スニーカーダンク' },
      { status: 400 },
    )
  }

  // 抽出ジョブをDBに登録
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction, error: insertError } = await (supabase as any)
    .from('extractions')
    .insert({
      user_id: user.id,
      source_url: url,
      source_site: scraper.siteKey,
      seller_account_id: sellerAccountId || null,
      category_id: categoryId || null,
      bulk_edit_setting_id: bulkEditSettingId || null,
      memo: memo ?? '',
      is_bulk: isBulk ?? false,
      status: 'processing',
      progress: 0,
    })
    .select()
    .single() as { data: Extraction | null; error: unknown }

  if (insertError || !extraction) {
    const msg = insertError instanceof Error ? insertError.message : JSON.stringify(insertError)
    console.error('Extract insert error:', msg)
    return NextResponse.json({ error: `DB error: ${msg}` }, { status: 500 })
  }

  const extractionId = extraction.id
  const userId = user.id

  // レスポンス返却後にバックグラウンドでスクレイピング実行
  after(async () => {
    // service role clientで認証不要のDB操作
    const bg = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    await runScrape(userId, extractionId, url, bulkEditSettingId || null, bg)
  })

  return NextResponse.json({ extractionId }, { status: 200 })
}

async function runScrape(
  userId: string,
  extractionId: string,
  url: string,
  bulkEditSettingId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
) {
  try {
    const limit = 600

    // 抽出設定を取得
    const [{ data: dangerSellers }, { data: dangerWords }, { data: replaceWords }, { data: extractionSettings }] = await Promise.all([
      supabase.from('danger_sellers').select('seller_url').eq('user_id', userId),
      supabase.from('danger_words').select('word').eq('user_id', userId),
      supabase.from('replace_words').select('before_word, after_word').eq('user_id', userId),
      supabase.from('extraction_settings').select('*').eq('user_id', userId).single(),
    ])

    // アクティブHTMLテンプレートを取得
    let activeTemplate: string | null = null
    if (extractionSettings?.html_template_id) {
      const { data: tmpl } = await supabase
        .from('html_templates')
        .select('content')
        .eq('id', extractionSettings.html_template_id)
        .single()
      activeTemplate = tmpl?.content ?? null
    }

    // 危険セラーチェック: 抽出URLが危険セラーと一致する場合はスキップ
    const sellerUrls: string[] = (dangerSellers ?? []).map((s: { seller_url: string }) =>
      s.seller_url.split('?')[0].trim().replace(/\/+$/, ''),
    )
    const normalizedUrl = url.split('?')[0].trim().replace(/\/+$/, '')
    if (sellerUrls.some((s) => normalizedUrl.startsWith(s))) {
      await supabase
        .from('extractions')
        .update({ status: 'excluded', progress: 0, extracted_at: new Date().toISOString() })
        .eq('id', extractionId)
      return
    }

    const scrapedList = await scrapeUrl(url, {
      limit,
      onPage: async (fetched, total) => {
        const pct = Math.min(Math.round((fetched / total) * 90), 90)
        await supabase
          .from('extractions')
          .update({ progress: pct })
          .eq('id', extractionId)
      },
    })

    // 危険単語フィルタ
    const wordList: string[] = (dangerWords ?? []).map((w: { word: string }) => w.word.toLowerCase())
    const filteredList = wordList.length === 0
      ? scrapedList
      : scrapedList.filter((scraped: { title: string }) => {
          const lower = scraped.title.toLowerCase()
          return !wordList.some((word) => lower.includes(word))
        })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let setting: any = null
    if (bulkEditSettingId) {
      const { data } = await supabase
        .from('bulk_edit_settings')
        .select('*')
        .eq('id', bulkEditSettingId)
        .single()
      setting = data
    }

    const replacePairs: { before_word: string; after_word: string }[] = replaceWords ?? []

    function applyTemplate(tmpl: string, data: {
      title: string; originalTitle: string; description: string
      condition: string | null; price: number | null; images: string[]
    }): string {
      const imgTags = data.images.map((src) => `<img src="${src}" style="max-width:100%;margin:4px 0">`).join('\n')
      return tmpl
        .replace(/\{\{title\}\}/g, data.title)
        .replace(/\{\{original_title\}\}/g, data.originalTitle)
        .replace(/\{\{description\}\}/g, data.description)
        .replace(/\{\{condition\}\}/g, data.condition ?? '')
        .replace(/\{\{price\}\}/g, data.price ? `¥${data.price.toLocaleString()}` : '')
        .replace(/\{\{images\}\}/g, imgTags)
        .replace(/\{\{image(\d+)\}\}/g, (_, n) => data.images[parseInt(n) - 1] ?? '')
    }

    function applyReplaces(title: string): string {
      let result = title
      for (const { before_word, after_word } of replacePairs) {
        result = result.split(before_word).join(after_word)
      }
      return result
    }

    // タイトル翻訳
    const titleEngine: string = extractionSettings?.title_engine ?? 'high'
    const titleEnabled: boolean = extractionSettings?.title_enabled ?? true
    const originalTitles = filteredList.map((s: { title: string }) => s.title)
    let translatedTitles: string[] = originalTitles
    if (titleEnabled && process.env.OPENAI_API_KEY) {
      try {
        translatedTitles = await translateTitles(originalTitles, titleEngine)
      } catch (e) {
        console.error('Translation failed, using original titles:', e)
      }
    }

    // 重複除外チェック用に既存商品を取得
    const excludeActive: boolean = extractionSettings?.exclude_active_duplicate ?? true
    const excludeTitle: boolean = extractionSettings?.exclude_title_duplicate ?? false
    const excludeTranslated: boolean = extractionSettings?.exclude_translated_duplicate ?? false

    let existingSourceUrls = new Set<string>()
    let existingOriginalTitles = new Set<string>()
    let existingEbayTitles = new Set<string>()

    if (excludeActive || excludeTitle || excludeTranslated) {
      const selectCols = [
        excludeActive ? 'source_url,listing_status' : '',
        excludeTitle ? 'original_title' : '',
        excludeTranslated ? 'ebay_title' : '',
      ].filter(Boolean).join(',')

      const { data: existingProducts } = await supabase
        .from('products')
        .select(selectCols)
        .eq('user_id', userId)

      if (existingProducts) {
        for (const p of existingProducts) {
          if (excludeActive && p.listing_status === 'listed' && p.source_url) {
            existingSourceUrls.add(p.source_url)
          }
          if (excludeTitle && p.original_title) existingOriginalTitles.add(p.original_title)
          if (excludeTranslated && p.ebay_title) existingEbayTitles.add(p.ebay_title)
        }
      }
    }

    const rows = filteredList.map((scraped: {
      sourceUrl: string; sourceSite: string; sourceItemId: string | null
      title: string; price: number | null; description: string
      images: string[]; condition: string | null
    }, idx: number) => {
      let ebayTitle = applyReplaces(translatedTitles[idx] ?? scraped.title)
      let ebayPrice: number | null = scraped.price
      if (setting) {
        ebayTitle = `${setting.title_prefix}${ebayTitle}${setting.title_suffix}`.slice(0, 80)
        ebayPrice = scraped.price ? Math.ceil(scraped.price * setting.price_rate) : null
      }
      return {
        user_id: userId,
        extraction_id: extractionId,
        source_url: scraped.sourceUrl,
        source_site: scraped.sourceSite,
        source_item_id: scraped.sourceItemId,
        original_title: scraped.title,
        original_price: scraped.price,
        original_description: scraped.description,
        original_images: scraped.images,
        original_condition: scraped.condition,
        ebay_title: ebayTitle,
        ebay_price: ebayPrice,
        ebay_description: activeTemplate
          ? applyTemplate(activeTemplate, {
              title: ebayTitle,
              originalTitle: scraped.title,
              description: scraped.description,
              condition: scraped.condition,
              price: scraped.price,
              images: scraped.images,
            })
          : scraped.description,
        ebay_images: scraped.images,
        listing_status: 'draft' as const,
      }
    })

    // 重複除外フィルタ
    const deduped = rows.filter((row: {
      source_url: string; original_title: string; ebay_title: string
    }) => {
      if (excludeActive && existingSourceUrls.has(row.source_url)) return false
      if (excludeTitle && existingOriginalTitles.has(row.original_title)) return false
      if (excludeTranslated && existingEbayTitles.has(row.ebay_title)) return false
      return true
    })

    // 100件ずつ分割してinsert
    const chunkSize = 100
    for (let i = 0; i < deduped.length; i += chunkSize) {
      await supabase.from('products').insert(deduped.slice(i, i + chunkSize))
    }

    await Promise.all([
      supabase
        .from('extractions')
        .update({ status: 'completed', progress: 100, extracted_at: new Date().toISOString() })
        .eq('id', extractionId),
      supabase.rpc('increment_extraction_used', { user_id: userId }),
    ])
  } catch (err) {
    const message = err instanceof ScraperError ? err.message : '不明なエラー'
    console.error('Scrape failed:', message)
    await supabase
      .from('extractions')
      .update({ status: 'failed', progress: 0 })
      .eq('id', extractionId)
  }
}
