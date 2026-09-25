import type { SupabaseClient } from '@supabase/supabase-js'
import { checkSupplierListings, normalizePriceChangeFilter, type SupplierCheckResult } from '@/lib/inventory-supplier-check'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'
import { resolveDelistEligibility } from '@/lib/inventory-delist'
import { reviseInventoryStatusBatch } from '@/lib/ebay-actions'
import { markListingsDelisted } from '@/lib/inventory-sync'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'

// ユーザー要望: 出品数が1,000件を超えても「売り切れを早く検知して取り下げる」を
// 維持したい。日次の在庫管理(1回80秒・約65件)だけでは一巡に日数がかかるため、
// pg_cron から15分ごとに少しずつ仕入先を確認する。
//  - Yahoo!フリマ: 商品ページの制限(約15件/15分/IP)に合わせて12件
//  - それ以外(メルカリ等): 制限が緩いので多めに確認する
// 売り切れが見つかり「自動取り下げ」「売り切れ即取り下げ」がONなら、その場で
// eBayの在庫を0にする(価格の反映は日次の価格改定に任せる)。

export interface QuickCheckOptions {
  batchSize: number
  timeBudgetMs: number
  runType: string
  sourceSite?: string
  excludeSourceSites?: string[]
  lastAtColumn?: string
}

export interface QuickCheckUserResult {
  user_id: string
  check?: Partial<SupplierCheckResult>
  delist?: { total: number; succeeded: number }
  error?: string
}

export async function runQuickSupplierCheck(
  db: SupabaseClient,
  options: QuickCheckOptions,
): Promise<QuickCheckUserResult[]> {
  const { data: allSettings } = await db
    .from('inventory_settings')
    .select('user_id, ebay_token, ebay_refresh_token, ebay_token_expires_at, auto_delist, days_until_delist, delist_by_age_enabled, delist_on_sold_out, price_change_direction, price_change_threshold_rate, delist_on_title_change')
    .eq('sync_enabled', true)

  const results: QuickCheckUserResult[] = []
  for (const settings of allSettings ?? []) {
    const userId = settings.user_id as string
    const userResult: QuickCheckUserResult = { user_id: userId }
    const startedAt = new Date().toISOString()
    try {
      const check = await checkSupplierListings(db, userId, options.batchSize, {
        timeBudgetMs: options.timeBudgetMs,
        priceChangeFilter: normalizePriceChangeFilter(settings),
        sourceSite: options.sourceSite,
        excludeSourceSites: options.excludeSourceSites,
        delistOnTitleChange: settings.delist_on_title_change ?? true,
      })
      userResult.check = {
        total: check.total, available: check.available, unavailable: check.unavailable,
        skipped: check.skipped, rate_limited: check.rate_limited, price_recalculated: check.price_recalculated,
        title_changed_delisted: check.title_changed_delisted,
      }
      if (options.lastAtColumn) {
        await db.from('inventory_settings').update({ [options.lastAtColumn]: new Date().toISOString() }).eq('user_id', userId)
      }

      // 変化があったときだけ実行履歴に残す(15分ごとに履歴が埋まらないように)
      if (check.unavailable > 0 || check.price_recalculated > 0 || check.title_changed > 0 || check.rate_limited > 0 || check.failed > 0) {
        await db.from('inventory_runs').insert({
          user_id: userId,
          run_type: options.runType,
          status: check.failed > 0 ? 'failed' : 'completed',
          result_summary: check,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
      }

      // 売り切れ即取り下げ
      const eligibility = resolveDelistEligibility(settings)
      if (check.unavailable > 0 && settings.auto_delist && eligibility.enabled && eligibility.immediate) {
        const tokenResolver = await createInventoryTokenResolver(db, userId, settings)
        const { data: listings } = await db
          .from('inventory_active_listings')
          .select('ebay_item_id, seller_account_id, site_id')
          .eq('user_id', userId)
          .not('product_id', 'is', null)
          .eq('quantity', 0)
          .is('delisted_at', null)
        // 出品したセラーのトークン・サイトで取り下げる(他アカウントの出品は触らない)
        const entriesBySeller = new Map<string | null, Array<{ itemId: string; quantity: number; siteId: string | null }>>()
        for (const l of listings ?? []) {
          const key = (l.seller_account_id as string | null) ?? null
          const list = entriesBySeller.get(key) ?? []
          list.push({ itemId: l.ebay_item_id as string, quantity: 0, siteId: (l.site_id as string | null) ?? 'US' })
          entriesBySeller.set(key, list)
        }
        const entries = Array.from(entriesBySeller.values()).flat()
        if (entries.length > 0) {
          const delistResults: Array<{ itemId: string; success: boolean; error?: string }> = []
          for (const [sellerAccountId, sellerEntries] of entriesBySeller) {
            const token = tokenResolver.tokenFor(sellerAccountId)
            if (!token) continue
            delistResults.push(...(await reviseInventoryStatusBatch(token, sellerEntries)).results)
          }
          await markListingsDelisted(db, userId, delistResults.filter(r => r.success).map(r => r.itemId))
          const run = summarizeInventoryActionRun(delistResults)
          const items = delistResults.map(r => ({ ebay_item_id: r.itemId, action: 'Revise', reason: 'sold_out', success: r.success, error: r.error ?? null }))
          await db.from('inventory_runs').insert({
            user_id: userId, run_type: 'auto_delist', status: run.status, error_message: run.errorMessage,
            result_summary: { total: delistResults.length, succeeded: delistResults.filter(r => r.success).length, immediate: true, source: options.runType, items },
            started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
          })
          userResult.delist = { total: delistResults.length, succeeded: delistResults.filter(r => r.success).length }
        }
      }
    } catch (error) {
      userResult.error = error instanceof Error ? error.message : String(error)
    }
    results.push(userResult)
  }
  return results
}
