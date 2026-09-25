import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { endItem, reviseQuantityToZero } from '@/lib/ebay-actions'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'
import { resolveDelistEligibility } from '@/lib/inventory-delist'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'
import { markListingsDelisted } from '@/lib/inventory-sync'

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET: 取り下げ対象リスト（quantity=0）のプレビュー
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const { data: settings, error: settingsError } = await db
    .from('inventory_settings')
    .select('days_until_delist, delist_by_age_enabled, delist_on_sold_out')
    .eq('user_id', user.id)
    .maybeSingle()

  if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })

  // 「N日経過取り下げ」も「売り切れ即取り下げ」もOFFのときは取り下げ対象なし
  const eligibility = resolveDelistEligibility(settings)
  if (!eligibility.enabled) {
    return NextResponse.json({ items: [], count: 0, disabled: true })
  }

  let query = db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, current_price, quantity, product_id, start_time')
    .eq('user_id', user.id)
    .eq('quantity', 0)
    .is('delisted_at', null)
  if (eligibility.cutoffIso) query = query.lte('start_time', eligibility.cutoffIso)
  const { data: listings, error: listingsError } = await query

  if (listingsError) return NextResponse.json({ error: listingsError.message }, { status: 500 })

  return NextResponse.json({ items: listings ?? [], count: (listings ?? []).length, immediate: eligibility.immediate })
}

// POST: 取り下げ実行
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  if (!Array.isArray(body.item_ids) || body.item_ids.length === 0) {
    return NextResponse.json({ error: '確認済みの item_ids を指定してください' }, { status: 400 })
  }
  if (body.item_ids.some((id: unknown) => typeof id !== 'string' || id.trim().length === 0)) {
    return NextResponse.json({ error: 'item_ids は空でない文字列の配列で指定してください' }, { status: 400 })
  }

  const itemIds = [...new Set((body.item_ids as string[]).map(id => id.trim()))]
  if (itemIds.length > 100) {
    return NextResponse.json({ error: '一度に実行できるのは100件までです' }, { status: 400 })
  }

  const db = admin()

  const { data: settings, error: settingsError } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at, days_until_delist, delist_by_age_enabled, delist_on_sold_out')
    .eq('user_id', user.id)
    .maybeSingle()

  if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })
  const eligibility = resolveDelistEligibility(settings)
  if (!eligibility.enabled) {
    return NextResponse.json({ error: 'N日経過取り下げがOFFのため取り下げは実行できません' }, { status: 409 })
  }
  let query = db
    .from('inventory_active_listings')
    .select('ebay_item_id, product_id, quantity, start_time, seller_account_id, site_id')
    .eq('user_id', user.id)
    .eq('quantity', 0)
    .is('delisted_at', null)
    .in('ebay_item_id', itemIds)
  if (eligibility.cutoffIso) query = query.lte('start_time', eligibility.cutoffIso)
  const { data: listings, error: listingsError } = await query

  if (listingsError) return NextResponse.json({ error: listingsError.message }, { status: 500 })

  const eligibleIds = new Set((listings ?? []).map(listing => listing.ebay_item_id))
  const staleItemIds = itemIds.filter(itemId => !eligibleIds.has(itemId))
  if (staleItemIds.length > 0) {
    return NextResponse.json({
      error: '確認後に対象商品の状態が変わりました。プレビューを更新してください',
      item_ids: staleItemIds,
    }, { status: 409 })
  }

  // 対象がプレビュー時と一致した場合だけeBayトークンを解決する。
  // 出品ごとに、その出品を出したセラーのトークン・サイトIDで操作する。
  const tokenResolver = await createInventoryTokenResolver(db, user.id, settings ?? {})

  const results = []
  const actions = new Map<string, 'Revise' | 'End'>()
  const skippedUnknownSeller: string[] = []
  for (const l of listings ?? []) {
    const accessToken = tokenResolver.tokenFor(l.seller_account_id as string | null)
    if (!accessToken) { skippedUnknownSeller.push(l.ebay_item_id as string); continue }
    const siteId = (l.site_id as string | null) ?? 'US'
    let result
    if (l.product_id) {
      // 管理商品 → quantity=0にRevise（出品継続）
      result = await reviseQuantityToZero(accessToken, l.ebay_item_id, siteId)
      actions.set(l.ebay_item_id, 'Revise')
    } else {
      // 非管理商品 → End（完全取り下げ）
      result = await endItem(accessToken, l.ebay_item_id, siteId)
      actions.set(l.ebay_item_id, 'End')
    }
    results.push(result)
  }
  if (skippedUnknownSeller.length > 0) {
    console.warn('[delist] skipped listings without a known seller account:', skippedUnknownSeller.join(','))
  }
  const items = results.map(r => ({ ebay_item_id: r.itemId, action: actions.get(r.itemId) ?? 'Revise', reason: 'sold_out', success: r.success, error: r.error ?? null }))

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const runSummary = summarizeInventoryActionRun(results)
  await markListingsDelisted(db, user.id, results.filter(r => r.success).map(r => r.itemId))

  // 実行ログを記録
  await db.from('inventory_runs').insert({
    user_id: user.id,
    run_type: 'delist',
    status: runSummary.status,
    error_message: runSummary.errorMessage,
    result_summary: { total: results.length, succeeded, failed: failed.map(f => ({ id: f.itemId, error: f.error })), items },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
    // ignore log errors

  return NextResponse.json({ ok: true, total: results.length, succeeded, failed })
}
