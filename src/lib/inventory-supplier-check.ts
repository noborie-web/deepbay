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
  extraction_id: string | null
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
}

export async function checkSupplierListings(
  db: SupabaseClient,
  userId: string,
  batchLimit = 50,
): Promise<SupplierCheckResult> {
  const result: SupplierCheckResult = {
    total: 0,
    available: 0,
    unavailable: 0,
    skipped: 0,
    failed: 0,
    price_increased: 0,
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
    .select('id, source_url, purchase_price_jpy, extraction_id')
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
    const checkedAt = new Date().toISOString()
    const product = productMap.get(listing.product_id)
    const sourceUrl = product?.source_url ?? null
    let outcome: 'available' | 'unavailable' | 'skipped' = 'skipped'
    let quantity: number | undefined
    let newPurchasePriceJpy: number | undefined
    let newEbayPrice: number | undefined

    if (sourceUrl && findScraper(sourceUrl)) {
      try {
        const scrapedProducts = await scrapeUrl(sourceUrl, { limit: 1 })
        const scraped = scrapedProducts[0] as { availability?: string; price?: number | null } | undefined
        if (scraped?.availability === 'sold_out') {
          outcome = 'unavailable'
          quantity = 0
        } else {
          outcome = 'available'

          if (
            jpyPerUsd !== null
            && typeof scraped?.price === 'number'
            && typeof product?.purchase_price_jpy === 'number'
            && scraped.price > product.purchase_price_jpy
          ) {
            const bulkSettingId = product.extraction_id
              ? bulkSettingIdByExtractionId.get(product.extraction_id)
              : null
            const setting = bulkSettingId ? bulkSettingMap.get(bulkSettingId) : null
            const recalculated = calculateAutomaticEbayPrice(scraped.price, jpyPerUsd, setting)
            if (recalculated !== null) {
              newPurchasePriceJpy = scraped.price
              newEbayPrice = recalculated
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
          .update({ purchase_price_jpy: newPurchasePriceJpy, ebay_price: newEbayPrice })
          .eq('user_id', userId)
          .eq('id', listing.product_id)
        if (productUpdateError) throw new Error(productUpdateError.message)
        result.price_increased += 1
      } catch {
        // 価格更新の失敗は売り切れチェック(available/unavailable判定)の
        // 成否とは独立して扱い、failedとしては数えない。
      }
    }
  }

  return result
}
