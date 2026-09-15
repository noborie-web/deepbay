import type { SupabaseClient } from '@supabase/supabase-js'
import { findScraper, scrapeUrl } from '@/lib/scrapers'
import { fetchUsdJpyRate } from '@/lib/exchange-rate'
import { calculateAutomaticEbayPrice } from '@/lib/extraction-run'

interface SupplierListingRow {
  id: string
  product_id: string
}

interface SupplierProductRow {
  id: string
  source_url: string | null
  purchase_price_jpy: number | null
  ebay_price: number | null
  pricing_jpy_per_usd: number | null
  extraction_id: string | null
}

// 公式ツールの「価格追従ファイル絞り込み設定」相当。
// direction: 'any' = 指定なし / 'up' = 値上がりのみ反映 / 'down' = 値下がりのみ反映
// thresholdRate: 検知差分率(%)。現在価格からの変動率がこれ以上のときだけ更新する。
export type PriceChangeDirection = 'any' | 'up' | 'down'
export interface PriceChangeFilter {
  direction: PriceChangeDirection
  thresholdRate: number
}
export const DEFAULT_PRICE_CHANGE_FILTER: PriceChangeFilter = { direction: 'any', thresholdRate: 1 }

export function normalizePriceChangeFilter(input: {
  price_change_direction?: unknown
  price_change_threshold_rate?: unknown
} | null | undefined): PriceChangeFilter {
  const direction = input?.price_change_direction
  const rate = input?.price_change_threshold_rate
  const parsedRate = typeof rate === 'string' ? Number(rate) : rate
  return {
    direction: direction === 'up' || direction === 'down' ? direction : 'any',
    thresholdRate: typeof parsedRate === 'number' && Number.isFinite(parsedRate) && parsedRate >= 0
      ? parsedRate
      : DEFAULT_PRICE_CHANGE_FILTER.thresholdRate,
  }
}

// ユーザー要望: 「出品した時点の為替の変動の差も検知して再計算して価格に
// 反映する」。再計算した価格と現在のeBay価格の差が検知差分率以上で、
// 差分検知タイプに合う方向のときだけ更新する。
export function shouldUpdateEbayPrice(
  currentPrice: number | null | undefined,
  recalculated: number,
  filter: PriceChangeFilter = DEFAULT_PRICE_CHANGE_FILTER,
): boolean {
  if (typeof currentPrice !== 'number' || !Number.isFinite(currentPrice) || currentPrice <= 0) return true
  const diffRate = (recalculated - currentPrice) / currentPrice * 100
  if (filter.direction === 'up' && diffRate <= 0) return false
  if (filter.direction === 'down' && diffRate >= 0) return false
  if (diffRate === 0) return false
  return Math.abs(diffRate) >= filter.thresholdRate
}

// 為替変動分だけを既存のeBay価格に反映する(出品時レート/現在レート倍)。
// 価格一括編集などで手動調整した価格も、その調整を維持したまま為替分だけ
// 動かせる。セント単位に丸める。
export function scalePriceByExchangeRate(currentPrice: number, pricingJpyPerUsd: number, currentJpyPerUsd: number): number {
  return Math.round(currentPrice * pricingJpyPerUsd / currentJpyPerUsd * 100) / 100
}

// calculateAutomaticEbayPriceのsettingパラメータ(AutoPricingSetting)は
// extraction-run.tsからexportされていないが、TypeScriptは構造的型付けの
// ため、同じ形のオブジェクトであれば呼び出し側でこの型を明示的に
// importしなくても渡せる。
interface BulkEditPricingSetting {
  profit_rate?: number | string | null
  ebay_fee_rate?: number | string | null
  shipping_cost_jpy?: number | string | null
  fixed_cost_usd?: number | string | null
}

export interface SupplierCheckResult {
  total: number
  available: number
  unavailable: number
  skipped: number
  failed: number
  // ユーザー要望: 「仕入れ価格の高騰に確実に対応できる在庫管理」。
  // 仕入れ元の現在価格が前回記録したpurchase_price_jpyより上がっていた
  // 場合、eBay出品価格(ebay_price)を再計算して自動的に更新した件数。
  // 実際にeBayへ反映するのは、この直後に実行される既存の「価格改定」
  // 自動実行(products.ebay_priceとinventory_active_listingsの現在価格
  // の差分を検知する仕組み)が担う — ここではDB上の計算値だけを更新する。
  price_increased: number
  // 仕入価格の変動・為替レートの変動により eBay価格(ebay_price)を
  // 再計算して更新した件数(price_increased を含む)。
  price_recalculated: number
}

export interface SupplierCheckOptions {
  // この時間(ms)を超えたら残りは次回に回す(cronの実行時間上限対策)。
  // 未チェックが古い順に処理するため、次回は残りから続きが確認される。
  timeBudgetMs?: number
  // 価格更新の絞り込み(差分検知タイプ・検知差分率)
  priceChangeFilter?: PriceChangeFilter
}

export async function checkSupplierListings(
  db: SupabaseClient,
  userId: string,
  batchLimit = 50,
  options: SupplierCheckOptions = {},
): Promise<SupplierCheckResult> {
  const startedAt = Date.now()
  const result: SupplierCheckResult = {
    total: 0,
    available: 0,
    unavailable: 0,
    skipped: 0,
    failed: 0,
    price_increased: 0,
    price_recalculated: 0,
  }

  const { data: listings, error: listingsError } = await db
    .from('inventory_active_listings')
    .select('id, product_id')
    .eq('user_id', userId)
    .not('product_id', 'is', null)
    .gt('quantity', 0)
    .order('supplier_checked_at', { ascending: true, nullsFirst: true })
    .limit(batchLimit)

  if (listingsError) {
    throw new Error(`Supplier listing lookup failed: ${listingsError.message}`)
  }

  const targets = (listings ?? []) as SupplierListingRow[]
  result.total = targets.length
  if (targets.length === 0) return result

  const productIds = Array.from(new Set(targets.map(listing => listing.product_id)))
  const { data: products, error: productsError } = await db
    .from('products')
    .select('id, source_url, purchase_price_jpy, ebay_price, pricing_jpy_per_usd, extraction_id')
    .eq('user_id', userId)
    .in('id', productIds)

  if (productsError) {
    throw new Error(`Supplier product lookup failed: ${productsError.message}`)
  }

  const productMap = new Map(
    ((products ?? []) as SupplierProductRow[]).map(product => [product.id, product]),
  )

  // 価格再計算に使う一括編集設定(利益率等)を抽出単位でまとめて取得する。
  // 設定が見つからない商品はcalculateAutomaticEbayPrice側のデフォルト
  // 利益設定にフォールバックする。
  const extractionIds = Array.from(new Set(
    ((products ?? []) as SupplierProductRow[])
      .map(p => p.extraction_id)
      .filter((id): id is string => Boolean(id)),
  ))
  const bulkSettingIdByExtractionId = new Map<string, string | null>()
  if (extractionIds.length > 0) {
    const { data: extractions } = await db
      .from('extractions')
      .select('id, bulk_edit_setting_id')
      .in('id', extractionIds)
    for (const e of extractions ?? []) bulkSettingIdByExtractionId.set(e.id, e.bulk_edit_setting_id)
  }
  const bulkSettingIds = Array.from(new Set(
    Array.from(bulkSettingIdByExtractionId.values()).filter((id): id is string => Boolean(id)),
  ))
  const bulkSettingMap = new Map<string, BulkEditPricingSetting>()
  if (bulkSettingIds.length > 0) {
    const { data: bulkSettings } = await db
      .from('bulk_edit_settings')
      .select('id, profit_rate, ebay_fee_rate, shipping_cost_jpy, fixed_cost_usd')
      .in('id', bulkSettingIds)
    for (const s of bulkSettings ?? []) bulkSettingMap.set(s.id, s)
  }

  // 為替レート取得に失敗しても売り切れチェック自体は継続する
  // (価格高騰への自動対応だけをスキップする)。
  let jpyPerUsd: number | null = null
  try {
    jpyPerUsd = (await fetchUsdJpyRate()).rate
  } catch {
    jpyPerUsd = null
  }

  for (const listing of targets) {
    if (options.timeBudgetMs !== undefined && Date.now() - startedAt > options.timeBudgetMs) {
      result.skipped += 1
      continue
    }
    const checkedAt = new Date().toISOString()
    const product = productMap.get(listing.product_id)
    const sourceUrl = product?.source_url ?? null
    let outcome: 'available' | 'unavailable' | 'skipped' = 'skipped'
    let quantity: number | undefined
    let newPurchasePriceJpy: number | undefined
    let newEbayPrice: number | undefined
    let priceIncreased = false
    // 為替レートの基準だけを記録する(価格は変えない)場合に使う
    let baselineJpyPerUsd: number | undefined
    const priceChangeFilter = options.priceChangeFilter ?? DEFAULT_PRICE_CHANGE_FILTER

    if (sourceUrl && findScraper(sourceUrl)) {
      try {
        const scrapedProducts = await scrapeUrl(sourceUrl, { limit: 1 })
        const scraped = scrapedProducts[0] as { availability?: string; price?: number | null } | undefined
        if (scraped?.availability === 'sold_out') {
          outcome = 'unavailable'
          quantity = 0
        } else {
          outcome = 'available'

          // 現在の仕入価格(取得できなければ前回記録した価格)を基に
          // eBay価格を見直す。
          //  - 仕入価格が変わった / 価格未設定 / 出品時レート未記録 →
          //    現在の仕入価格 × 現在の為替レートで計算式から再計算
          //  - 仕入価格が同じで出品時レートあり → 為替変動分だけ既存価格を
          //    スケール(手動調整した価格を維持)
          //  - 出品時レート未記録で価格あり・仕入価格同じ → 今回のレートを
          //    基準として記録するだけ(既存148件の初回チェック用。価格は変えない)
          const purchasePriceJpy = typeof scraped?.price === 'number' && scraped.price > 0
            ? scraped.price
            : product?.purchase_price_jpy ?? null
          if (jpyPerUsd !== null && product && purchasePriceJpy !== null) {
            const currentEbayPrice = typeof product.ebay_price === 'number' && product.ebay_price > 0
              ? product.ebay_price
              : null
            const pricingRate = typeof product.pricing_jpy_per_usd === 'number' && product.pricing_jpy_per_usd > 0
              ? product.pricing_jpy_per_usd
              : null
            const purchasePriceChanged = typeof product.purchase_price_jpy === 'number'
              ? Math.abs(purchasePriceJpy - product.purchase_price_jpy) >= 1
              : true

            let recalculated: number | null = null
            if (purchasePriceChanged || currentEbayPrice === null) {
              const bulkSettingId = product.extraction_id
                ? bulkSettingIdByExtractionId.get(product.extraction_id)
                : null
              const setting = bulkSettingId ? bulkSettingMap.get(bulkSettingId) : null
              recalculated = calculateAutomaticEbayPrice(purchasePriceJpy, jpyPerUsd, setting)
            } else if (pricingRate !== null) {
              recalculated = scalePriceByExchangeRate(currentEbayPrice, pricingRate, jpyPerUsd)
            } else {
              baselineJpyPerUsd = jpyPerUsd
            }

            if (recalculated !== null && shouldUpdateEbayPrice(currentEbayPrice, recalculated, priceChangeFilter)) {
              newPurchasePriceJpy = purchasePriceJpy
              newEbayPrice = recalculated
              if (
                typeof product.purchase_price_jpy === 'number'
                && purchasePriceJpy > product.purchase_price_jpy
              ) priceIncreased = true
            }
          }
        }
      } catch {
        // 商品詳細を再取得できない場合は、仕入れ元ページの削除として扱う。
        outcome = 'unavailable'
        quantity = 0
      }
    }

    const update: { supplier_checked_at: string; quantity?: number } = {
      supplier_checked_at: checkedAt,
    }
    if (quantity !== undefined) update.quantity = quantity

    try {
      const { error: updateError } = await db
        .from('inventory_active_listings')
        .update(update)
        .eq('user_id', userId)
        .eq('id', listing.id)
      if (updateError) throw new Error(updateError.message)
      result[outcome] += 1
    } catch {
      // 1件の更新失敗で、残りの仕入れ元チェックを中断しない。
      result.failed += 1
      continue
    }

    if (newPurchasePriceJpy !== undefined && newEbayPrice !== undefined) {
      try {
        const { error: productUpdateError } = await db
          .from('products')
          // 更新後の価格は現在のレートで計算した値なので、基準レートも更新する
          .update({ purchase_price_jpy: newPurchasePriceJpy, ebay_price: newEbayPrice, pricing_jpy_per_usd: jpyPerUsd })
          .eq('user_id', userId)
          .eq('id', listing.product_id)
        if (productUpdateError) throw new Error(productUpdateError.message)
        result.price_recalculated += 1
        if (priceIncreased) result.price_increased += 1
      } catch {
        // 価格更新の失敗は売り切れチェック(available/unavailable判定)の
        // 成否とは独立して扱い、failedとしては数えない。
      }
    } else if (baselineJpyPerUsd !== undefined) {
      try {
        await db
          .from('products')
          .update({ pricing_jpy_per_usd: baselineJpyPerUsd })
          .eq('user_id', userId)
          .eq('id', listing.product_id)
      } catch {
        // 基準レートの記録失敗は次回のチェックで再試行される
      }
    }
  }

  return result
}
