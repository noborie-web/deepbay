import type { SupabaseClient } from '@supabase/supabase-js'
import { reviseInventoryStatusBatch } from '@/lib/ebay-actions'
import { selectAllRows, selectByIds } from '@/lib/db-chunk'
import { onlyLiveListings } from '@/lib/inventory-listing-filter'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'
import type { InventoryAuthSettings } from '@/lib/inventory-auth'
import { decideSiteRevisePrice, loadJpyRates } from '@/lib/inventory-site-pricing'
import { currencyForSite } from '@/lib/ebay-sites'
import { adjustedJpyRate, loadPricingModel, sitePriceAdjustment } from '@/lib/inventory-pricing'
import { applyRevisedPrices } from '@/lib/inventory-sync'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'
import { EBAY_RESERVED_CALLS, remainingEbayCalls } from '@/lib/ebay-call-counter'

// ---------------------------------------------------------------------------
// 価格改定。
//
// 本番で確認した不具合(2026-10-23): 「価格改定を自動実行する」をONにしても、
// 実行の記録(auto_revise_price)が1件も残らなかった。
//
// 原因は時間の取り合い。日次cronは 同期 → 仕入先チェック → 取り下げ →
// 価格改定 の順で動くが、取り下げが終わる時点で既に236〜275秒を使っていた
// (実測4回)。関数の上限は300秒なので、価格改定は始まっても記録を書く前に
// 強制終了していた。ロジックで弾かれていたわけではないので、設定を見ても
// 原因が分からない形だった。
//
// 工程の順番を変えても時間の押し付け合いになるだけなので、価格改定は
// 独立したcronに分け、300秒をまるごと使えるようにする。
// ---------------------------------------------------------------------------

/** eBayへの送信に使ってよい時間。残りは次回に持ち越す */
export const REVISE_PRICE_TIME_BUDGET_MS = 240_000

export interface RevisePriceSummary {
  total: number
  succeeded: number
  /** 時間予算に収まらず次回へ回した件数 */
  deferred: number
  /** 出品通貨のレートが取れず送らなかった件数 */
  skipped_no_rate: number
  /** 15%超の値下げになる計算結果を止めた件数 */
  guarded: number
  /** どのセラーの出品か特定できず触らなかった件数 */
  skipped_unknown_seller: number
  /** 目標価格と現在価格の差が小さく、送る必要が無かった件数 */
  unchanged: number
  /** eBayの1日の呼び出し枠が足りず、翌日に回した件数 */
  deferred_daily_limit: number
  items: Array<{
    ebay_item_id: string
    price_before: number | null
    price_after: number | null
    diff: number | null
    success: boolean
    error: string | null
  }>
}

export interface RevisePriceResult {
  summary: RevisePriceSummary
  status: string
  errorMessage: string | null
}

function groupEntriesBySeller<T extends { sellerAccountId?: string | null }>(
  entries: T[],
): Array<[string | null, T[]]> {
  const groups = new Map<string | null, T[]>()
  for (const entry of entries) {
    const key = entry.sellerAccountId ?? null
    const list = groups.get(key) ?? []
    list.push(entry)
    groups.set(key, list)
  }
  return Array.from(groups.entries())
}

export async function runRevisePriceForUser(
  db: SupabaseClient,
  userId: string,
  settings: InventoryAuthSettings,
  options: { timeBudgetMs?: number; startedAt?: number; maxCalls?: number } = {},
): Promise<RevisePriceResult> {
  const timeBudgetMs = options.timeBudgetMs ?? REVISE_PRICE_TIME_BUDGET_MS
  const startedAt = options.startedAt ?? Date.now()

  // 取り下げ済み・在庫0の出品は対象にしない(本番で373件の無駄な送信があった)
  type ReviseListing = {
    ebay_item_id: string; current_price: number | null; product_id: string | null
    seller_account_id: string | null; site_id: string | null; currency: string | null
  }
  const listings = await selectAllRows<ReviseListing>(() => onlyLiveListings(db
    .from('inventory_active_listings')
    .select('ebay_item_id, current_price, product_id, seller_account_id, site_id, currency')
    .eq('user_id', userId)
    .not('product_id', 'is', null))
    .order('ebay_item_id'))

  const productIds = listings.map(l => l.product_id as string).filter(Boolean)
  const productMap = new Map<string, { ebay_price: number | null; pricing_jpy_per_usd: number | null }>()
  if (productIds.length > 0) {
    const products = await selectByIds<{ id: string; ebay_price: number | null; pricing_jpy_per_usd: number | null }>(
      db, 'products', 'id, ebay_price, pricing_jpy_per_usd', productIds,
    )
    for (const p of products) productMap.set(p.id, p)
  }

  // UK/AU出品はUSD価格を出品通貨へ換算して反映する(維持した利益額はそのまま)
  const pricingModel = await loadPricingModel(db, userId)
  const rates = await loadJpyRates(
    listings.map(l => (l.currency ?? 'USD')),
    (currency, rate, jpyPerUsd) => adjustedJpyRate(pricingModel, currency, rate, jpyPerUsd),
  )

  const tokenResolver = await createInventoryTokenResolver(db, userId, settings)

  const entries: Array<{ itemId: string; price: number; siteId: string | null; sellerAccountId: string | null }> = []
  const beforePrices = new Map<string, number>()
  let skippedNoRate = 0
  let guarded = 0
  let skippedUnknownSeller = 0
  let unchanged = 0

  for (const l of listings) {
    const p = productMap.get(l.product_id!)
    const currency = (l.currency ?? 'USD').toUpperCase()
    const decision = decideSiteRevisePrice({
      currentPrice: l.current_price,
      usdPrice: p?.ebay_price ?? null,
      jpyPerUsd: p?.pricing_jpy_per_usd ?? null,
      siteId: l.site_id ?? 'US',
      jpyPerCurrency: rates.get(currency) ?? null,
      priceAdjustment: sitePriceAdjustment(pricingModel, l.site_id ?? 'US'),
    })
    if (decision.action === 'skip') {
      if (decision.reason === 'no_rate') skippedNoRate += 1
      if (decision.reason === 'unchanged') unchanged += 1
      if (decision.reason === 'guarded') {
        guarded += 1
        console.warn(`[revise-price] guarded: ${l.ebay_item_id} ${l.current_price} -> (${currency}) 計算結果が15%超の値下げ`)
      }
      continue
    }
    if (!tokenResolver.tokenFor(l.seller_account_id)) { skippedUnknownSeller += 1; continue }
    entries.push({
      itemId: l.ebay_item_id,
      price: decision.price,
      siteId: l.site_id ?? 'US',
      sellerAccountId: l.seller_account_id,
    })
    beforePrices.set(l.ebay_item_id, Number(l.current_price))
  }

  // eBayの1日の枠に収まる分だけ送る。使い切ってから失敗すると、その日の
  // 同期・取り下げ(売り切れ検知)まで道連れになる。
  const budget = options.maxCalls ?? await remainingEbayCalls(db, userId, { reserved: EBAY_RESERVED_CALLS })
  let deferredDailyLimit = 0
  let sendable = entries
  if (entries.length > budget) {
    deferredDailyLimit = entries.length - budget
    sendable = entries.slice(0, Math.max(0, budget))
    console.warn(`[revise-price] eBayの1日の枠が残り${budget}件。${deferredDailyLimit}件は翌日に回す`)
  }

  const results: Array<{ itemId: string; success: boolean; error?: string }> = []
  let deferred = 0
  for (const [accountId, sellerEntries] of groupEntriesBySeller(sendable)) {
    const token = tokenResolver.tokenFor(accountId)
    if (!token) { skippedUnknownSeller += sellerEntries.length; continue }
    const batch = await reviseInventoryStatusBatch(
      token, sellerEntries, { deadlineMs: startedAt + timeBudgetMs },
    )
    results.push(...batch.results)
    deferred += batch.deferred
  }

  // 反映した価格を在庫一覧にも書く(次回同期を待たずに差分が消える)
  try {
    await applyRevisedPrices(db, userId, results.filter(r => r.success).map(r => {
      const entry = entries.find(e => e.itemId === r.itemId)
      return {
        ebay_item_id: r.itemId,
        price: entry?.price ?? 0,
        jpy_per_currency: entry ? rates.get(currencyForSite(entry.siteId)) ?? null : null,
      }
    }).filter(r => r.price > 0))
  } catch (error) {
    console.warn('[revise-price] 価格の書き戻しに失敗:', error instanceof Error ? error.message : error)
  }

  const items = results.map(r => {
    const after = entries.find(e => e.itemId === r.itemId)?.price ?? null
    const before = beforePrices.get(r.itemId) ?? null
    return {
      ebay_item_id: r.itemId,
      price_before: before,
      price_after: after,
      diff: after !== null && before !== null ? Math.round((after - before) * 100) / 100 : null,
      success: r.success,
      error: r.error ?? null,
    }
  })

  const run = summarizeInventoryActionRun(results)
  return {
    summary: {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      deferred,
      skipped_no_rate: skippedNoRate,
      guarded,
      skipped_unknown_seller: skippedUnknownSeller,
      unchanged,
      deferred_daily_limit: deferredDailyLimit,
      items,
    },
    status: run.status,
    errorMessage: run.errorMessage,
  }
}
