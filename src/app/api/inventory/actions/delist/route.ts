import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { endItem, reviseQuantityToZero } from '@/lib/ebay-actions'
import { resolveInventoryAccessToken } from '@/lib/inventory-auth'
import { getDelistCutoffIso } from '@/lib/inventory-delist'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'

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
    .select('days_until_delist')
    .eq('user_id', user.id)
    .maybeSingle()

  if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })

  const cutoff = getDelistCutoffIso(settings?.days_until_delist)
  const { data: listings, error: listingsError } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, current_price, quantity, product_id, start_time')
    .eq('user_id', user.id)
    .eq('quantity', 0)
    .lte('start_time', cutoff)

  if (listingsError) return NextResponse.json({ error: listingsError.message }, { status: 500 })

  return NextResponse.json({ items: listings ?? [], count: (listings ?? []).length })
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
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at, days_until_delist')
    .eq('user_id', user.id)
    .maybeSingle()

  if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })
  const cutoff = getDelistCutoffIso(settings?.days_until_delist)
  const { data: listings, error: listingsError } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, product_id, quantity, start_time')
    .eq('user_id', user.id)
    .eq('quantity', 0)
    .in('ebay_item_id', itemIds)
    .lte('start_time', cutoff)

  if (listingsError) return NextResponse.json({ error: listingsError.message }, { status: 500 })

  const eligibleIds = new Set((listings ?? []).map(listing => listing.ebay_item_id))
  const staleItemIds = itemIds.filter(itemId => !eligibleIds.has(itemId))
  if (staleItemIds.length > 0) {
    return NextResponse.json({
      error: '確認後に対象商品の状態が変わりました。プレビューを更新してください',
      item_ids: staleItemIds,
    }, { status: 409 })
  }

  // 対象がプレビュー時と一致した場合だけeBayトークンを解決する
  const accessToken = await resolveInventoryAccessToken(db, user.id, settings ?? {})

  const results = []
  for (const l of listings ?? []) {
    let result
    if (l.product_id) {
      // 管理商品 → quantity=0にRevise（出品継続）
      result = await reviseQuantityToZero(accessToken, l.ebay_item_id)
    } else {
      // 非管理商品 → End（完全取り下げ）
      result = await endItem(accessToken, l.ebay_item_id)
    }
    results.push(result)
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const runSummary = summarizeInventoryActionRun(results)

  // 実行ログを記録
  await db.from('inventory_runs').insert({
    user_id: user.id,
    run_type: 'delist',
    status: runSummary.status,
    error_message: runSummary.errorMessage,
    result_summary: { total: results.length, succeeded, failed: failed.map(f => ({ id: f.itemId, error: f.error })) },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
    // ignore log errors

  return NextResponse.json({ ok: true, total: results.length, succeeded, failed })
}
