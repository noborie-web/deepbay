import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scrapeUrl, findScraper, ScraperError } from '@/lib/scrapers'
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

    const rows = scrapedList.map((scraped: {
      sourceUrl: string; sourceSite: string; sourceItemId: string | null
      title: string; price: number | null; description: string
      images: string[]; condition: string | null
    }) => {
      let ebayTitle = scraped.title
      let ebayPrice: number | null = scraped.price
      if (setting) {
        ebayTitle = `${setting.title_prefix}${scraped.title}${setting.title_suffix}`.slice(0, 80)
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
        ebay_description: scraped.description,
        ebay_images: scraped.images,
        listing_status: 'draft' as const,
      }
    })

    // 100件ずつ分割してinsert
    const chunkSize = 100
    for (let i = 0; i < rows.length; i += chunkSize) {
      await supabase.from('products').insert(rows.slice(i, i + chunkSize))
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
