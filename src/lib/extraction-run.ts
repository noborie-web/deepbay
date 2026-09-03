import { scrapeUrl } from '@/lib/scrapers'
import { translateTitles } from '@/lib/translate'
import { fetchUsdJpyRate } from '@/lib/exchange-rate'
import { calcProfit, DEFAULT_AUTO_PRICING, validateProfitParams } from '@/lib/pricing'

interface AutoPricingSetting {
  profit_rate?: number | string | null
  ebay_fee_rate?: number | string | null
  shipping_cost_jpy?: number | string | null
  fixed_cost_usd?: number | string | null
}

function settingNumber(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function calculateAutomaticEbayPrice(
  purchasePriceJpy: number | null,
  jpyPerUsd: number | null,
  setting?: AutoPricingSetting | null,
): number | null {
  if (purchasePriceJpy === null || purchasePriceJpy <= 0 || jpyPerUsd === null) return null

  const ebayFeeRate = settingNumber(setting?.ebay_fee_rate, DEFAULT_AUTO_PRICING.ebayFeeRate)
  const targetProfitRate = settingNumber(setting?.profit_rate, DEFAULT_AUTO_PRICING.profitRate)
  const shippingCostJpy = settingNumber(setting?.shipping_cost_jpy, DEFAULT_AUTO_PRICING.shippingCostJpy)
  const fixedCostUsd = settingNumber(setting?.fixed_cost_usd, DEFAULT_AUTO_PRICING.fixedCostUsd)
  const params = {
    purchasePriceJpy,
    jpyPerUsd,
    ebayFeeRate,
    targetProfitRate,
    shippingUsd: shippingCostJpy / jpyPerUsd,
    fixedCostUsd,
  }
  if (validateProfitParams(params)) return null
  return calcProfit(params).salePriceUsd
}

export type ExtractionRunResult =
  | { status: 'completed' }
  | { status: 'excluded' }
  | { status: 'failed'; errorMessage: string }

export async function runScrape(
  userId: string,
  extractionId: string,
  url: string,
  bulkEditSettingId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<ExtractionRunResult> {
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
      return { status: 'excluded' }
    }

    const scrapedList = await scrapeUrl(url, {
      limit,
      // 危険セラーが1件も登録されていなければ、出品者URL取得のための
      // 追加コスト(ラクマ等、検索結果に出品者情報がないサイトでは商品
      // ごとの個別ページアクセスが必要)を払わない。
      fetchSellerInfo: sellerUrls.length > 0,
      onPage: async (fetched, total) => {
        const pct = Math.min(Math.round((fetched / total) * 90), 90)
        await supabase
          .from('extractions')
          .update({ progress: pct })
          .eq('id', extractionId)
      },
    })

    // 除外詳細(公式ツールの「抽出結果確認」に相当する内訳)を段階ごとに記録する。
    const detailFetchCount = scrapedList.length

    // 危険単語フィルタ
    const wordList: string[] = (dangerWords ?? []).map((w: { word: string }) => w.word.toLowerCase())
    const filteredList = wordList.length === 0
      ? scrapedList
      : scrapedList.filter((scraped: { title: string }) => {
          const lower = scraped.title.toLowerCase()
          return !wordList.some((word) => lower.includes(word))
        })
    const dangerWordExcluded = scrapedList.length - filteredList.length

    // 個別危険Seller除外: 検索結果内に登録済み危険セラーの商品が混ざっている
    // 場合、その商品だけを除外する(抽出URL自体が危険セラーのページである
    // 場合は上のチェックで既にスキップ済み)。スクレイパーが出品者URLを
    // 取得できるサイトのみ対象(sellerUrlが取得できない場合は判定しない)。
    const sellerFilteredList = sellerUrls.length === 0
      ? filteredList
      : filteredList.filter((scraped: { sellerUrl?: string | null }) => {
          if (!scraped.sellerUrl) return true
          const normalizedSellerUrl = scraped.sellerUrl.split('?')[0].trim().replace(/\/+$/, '')
          return !sellerUrls.some((s) => normalizedSellerUrl.startsWith(s))
        })
    const individualDangerSellerExcluded = filteredList.length - sellerFilteredList.length

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

    // 為替レートは抽出1回につき1度だけ取得する。失敗時は価格未設定で抽出を継続する。
    let jpyPerUsd: number | null = null
    try {
      jpyPerUsd = (await fetchUsdJpyRate()).rate
    } catch (error) {
      console.warn('Exchange rate fetch failed; ebay_price remains unset:', error)
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
    const originalTitles = sellerFilteredList.map((s: { title: string }) => s.title)
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

    const existingSourceUrls = new Set<string>()
    const existingOriginalTitles = new Set<string>()
    const existingEbayTitles = new Set<string>()

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

    const rows = sellerFilteredList.map((scraped: {
      sourceUrl: string; sourceSite: string; sourceItemId: string | null
      title: string; price: number | null; description: string
      images: string[]; condition: string | null
      sellerRatingCount: number | null; shippingDays: number | null; sourceUpdatedAt: string | null
    }, idx: number) => {
      let ebayTitle = applyReplaces(translatedTitles[idx] ?? scraped.title)
      if (setting) {
        ebayTitle = `${setting.title_prefix}${ebayTitle}${setting.title_suffix}`.slice(0, 80)
      }
      const ebayPrice = calculateAutomaticEbayPrice(scraped.price, jpyPerUsd, setting)
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
        seller_rating_count: scraped.sellerRatingCount,
        shipping_days: scraped.shippingDays,
        source_updated_at: scraped.sourceUpdatedAt,
      }
    })

    // 重複除外フィルタ。判定順(active→タイトル→翻訳後タイトル)は各行で
    // 排他的なので、除外詳細の内訳もこの順で1行1カウントとして集計する。
    let activeDuplicateExcluded = 0
    let titleDuplicateExcluded = 0
    let translatedDuplicateExcluded = 0
    const deduped = rows.filter((row: {
      source_url: string; original_title: string; ebay_title: string
    }) => {
      if (excludeActive && existingSourceUrls.has(row.source_url)) {
        activeDuplicateExcluded += 1
        return false
      }
      if (excludeTitle && existingOriginalTitles.has(row.original_title)) {
        titleDuplicateExcluded += 1
        return false
      }
      if (excludeTranslated && existingEbayTitles.has(row.ebay_title)) {
        translatedDuplicateExcluded += 1
        return false
      }
      return true
    })

    // 100件ずつ分割してinsert
    const chunkSize = 100
    for (let i = 0; i < deduped.length; i += chunkSize) {
      await supabase.from('products').insert(deduped.slice(i, i + chunkSize))
    }

    const exclusionSummary = {
      detail_fetch_count: detailFetchCount,
      danger_word_excluded: dangerWordExcluded,
      individual_danger_seller_excluded: individualDangerSellerExcluded,
      active_duplicate_excluded: activeDuplicateExcluded,
      title_duplicate_excluded: titleDuplicateExcluded,
      translated_duplicate_excluded: translatedDuplicateExcluded,
      completed_count: deduped.length,
    }

    await Promise.all([
      supabase
        .from('extractions')
        .update({
          status: 'completed',
          progress: 100,
          extracted_at: new Date().toISOString(),
          exclusion_summary: exclusionSummary,
        })
        .eq('id', extractionId),
      supabase.rpc('increment_extraction_used', { user_id: userId }),
    ])
    return { status: 'completed' }
  } catch (err) {
    const message = (err instanceof Error ? err.message : '不明なエラー').slice(0, 500)
    console.error('Scrape failed:', message)
    await supabase
      .from('extractions')
      .update({ status: 'failed', progress: 0, error_message: message })
      .eq('id', extractionId)
    return { status: 'failed', errorMessage: message }
  }
}
