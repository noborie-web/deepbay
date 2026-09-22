import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { reviseInventoryStatusBatch } from '@/lib/ebay-actions'
import { resolveInventoryAccessToken } from '@/lib/inventory-auth'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'
import { markListingsRestored } from '@/lib/inventory-sync'

// 本番で確認した不具合(2026-09-22): Yahoo!フリマの429を「売り切れ」と誤判定し、
// 64件の在庫を0にした。取り下げ実行(auto_delist / delist)の記録から、対象の
// 出品の在庫を1に戻して「出品中」に復帰させる(取り下げの取り消し)。
// 復帰後は次回の仕入先チェックで改めて判定される。
//  body: { run_id } または { item_ids: string[] }
export const maxDuration = 120

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { run_id?: string; item_ids?: unknown }
  const db = admin()

  let itemIds: string[] = []
  if (typeof body.run_id === 'string') {
    const { data: run } = await db
      .from('inventory_runs')
      .select('run_type, result_summary')
      .eq('id', body.run_id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!run) return NextResponse.json({ error: '実行履歴が見つかりません' }, { status: 404 })
    if (run.run_type !== 'auto_delist' && run.run_type !== 'delist') {
      return NextResponse.json({ error: '取り下げの実行ではありません' }, { status: 400 })
    }
    const items = Array.isArray(run.result_summary?.items) ? run.result_summary.items as Array<{ ebay_item_id: string; action: string; success: boolean }> : []
    // 在庫0にした(Revise)ものだけ戻せる。End(完全終了)した出品はeBay上で再出品が必要
    itemIds = items.filter(i => i.success && i.action === 'Revise').map(i => i.ebay_item_id)
  } else if (Array.isArray(body.item_ids)) {
    itemIds = body.item_ids.map(v => String(v)).filter(v => /^\d{9,15}$/.test(v))
  }
  itemIds = Array.from(new Set(itemIds))
  if (itemIds.length === 0) return NextResponse.json({ error: '戻せる出品がありません' }, { status: 400 })

  // Kakehashiの商品に紐付く出品だけを対象にする
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id')
    .eq('user_id', user.id)
    .not('product_id', 'is', null)
    .in('ebay_item_id', itemIds)
  const targetIds = (listings ?? []).map(l => l.ebay_item_id as string)
  if (targetIds.length === 0) return NextResponse.json({ error: '対象の出品が在庫一覧にありません' }, { status: 400 })

  const { data: settings } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()
  let accessToken: string
  try {
    accessToken = await resolveInventoryAccessToken(db, user.id, settings ?? {})
  } catch (error) {
    return NextResponse.json({ error: `eBayトークンの取得に失敗しました: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 })
  }

  const { results } = await reviseInventoryStatusBatch(accessToken, targetIds.map(itemId => ({ itemId, quantity: 1 })))
  const succeededIds = results.filter(r => r.success).map(r => r.itemId)
  const failed = results.filter(r => !r.success).map(r => ({ id: r.itemId, error: r.error }))
  await markListingsRestored(db, user.id, succeededIds)

  const runSummary = summarizeInventoryActionRun(results)
  await db.from('inventory_runs').insert({
    user_id: user.id,
    run_type: 'undo_delist',
    status: runSummary.status,
    error_message: runSummary.errorMessage,
    result_summary: { total: results.length, succeeded: succeededIds.length, failed, source_run_id: body.run_id ?? null, items: results.map(r => ({ ebay_item_id: r.itemId, action: 'Revise', reason: 'restored', success: r.success, error: r.error ?? null })) },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })

  return NextResponse.json({ ok: true, total: results.length, succeeded: succeededIds.length, failed })
}
