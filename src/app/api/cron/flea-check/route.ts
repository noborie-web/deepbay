import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { checkSupplierListings, normalizePriceChangeFilter } from '@/lib/inventory-supplier-check'
import { resolveInventoryAccessToken } from '@/lib/inventory-auth'
import { resolveDelistEligibility } from '@/lib/inventory-delist'
import { reviseInventoryStatusBatch } from '@/lib/ebay-actions'
import { markListingsDelisted } from '@/lib/inventory-sync'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'

// ユーザー要望: Yahoo!フリマ商品の売り切れチェックを速くしたい。
// Yahoo!フリマは商品ページを約15件/15分/IPしか見せないため、日次の在庫管理
// (1回12件)では264件の一巡に数日かかる。pg_cron から15分ごとにこのAPIを呼び、
// 毎回12件ずつ(未確認が古い順に)確認する → 1日約1,150件、全件を毎日確認できる。
// 売り切れが見つかり「自動取り下げ」「売り切れ即取り下げ」がONなら、その場で
// eBayの在庫を0にする(価格追従の再計算も同時に行うが、eBayへの価格反映は
// 日次の価格改定に任せる)。
export const maxDuration = 60

const FLEA_BATCH = 12
const TIME_BUDGET_MS = 40_000

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const db = admin()
  const { data: allSettings } = await db
    .from('inventory_settings')
    .select('user_id, ebay_token, ebay_refresh_token, ebay_token_expires_at, auto_delist, days_until_delist, delist_by_age_enabled, delist_on_sold_out, price_change_direction, price_change_threshold_rate')
    .eq('sync_enabled', true)

  const results: Record<string, unknown>[] = []
  for (const settings of allSettings ?? []) {
    const userId = settings.user_id as string
    const userResult: Record<string, unknown> = { user_id: userId }
    const startedAt = new Date().toISOString()
    try {
      const check = await checkSupplierListings(db, userId, FLEA_BATCH, {
        timeBudgetMs: TIME_BUDGET_MS,
        priceChangeFilter: normalizePriceChangeFilter(settings),
        sourceSite: 'yahoo_flea',
      })
      userResult.check = { total: check.total, available: check.available, unavailable: check.unavailable, skipped: check.skipped, rate_limited: check.rate_limited, price_recalculated: check.price_recalculated }
      await db.from('inventory_settings').update({ flea_check_last_at: new Date().toISOString() }).eq('user_id', userId)

      // 変化があったときだけ実行履歴に残す(15分ごとに履歴が埋まらないように)
      if (check.unavailable > 0 || check.price_recalculated > 0 || check.title_changed > 0 || check.rate_limited > 0 || check.failed > 0) {
        await db.from('inventory_runs').insert({
          user_id: userId,
          run_type: 'flea_check',
          status: check.failed > 0 ? 'failed' : 'completed',
          result_summary: check,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
      }

      // 売り切れ即取り下げ
      const eligibility = resolveDelistEligibility(settings)
      if (check.unavailable > 0 && settings.auto_delist && eligibility.enabled && eligibility.immediate) {
        const accessToken = await resolveInventoryAccessToken(db, userId, settings)
        const { data: listings } = await db
          .from('inventory_active_listings')
          .select('ebay_item_id')
          .eq('user_id', userId)
          .not('product_id', 'is', null)
          .eq('quantity', 0)
          .is('delisted_at', null)
        const entries = (listings ?? []).map(l => ({ itemId: l.ebay_item_id as string, quantity: 0 }))
        if (entries.length > 0) {
          const { results: delistResults } = await reviseInventoryStatusBatch(accessToken, entries)
          await markListingsDelisted(db, userId, delistResults.filter(r => r.success).map(r => r.itemId))
          const run = summarizeInventoryActionRun(delistResults)
          const items = delistResults.map(r => ({ ebay_item_id: r.itemId, action: 'Revise', reason: 'sold_out', success: r.success, error: r.error ?? null }))
          await db.from('inventory_runs').insert({
            user_id: userId, run_type: 'auto_delist', status: run.status, error_message: run.errorMessage,
            result_summary: { total: delistResults.length, succeeded: delistResults.filter(r => r.success).length, immediate: true, source: 'flea_check', items },
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
  return NextResponse.json({ ok: true, results })
}
