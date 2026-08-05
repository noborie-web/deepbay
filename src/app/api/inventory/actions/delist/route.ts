import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { endItem, reviseQuantityToZero, resolveAccessToken } from '@/lib/ebay-actions'

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET: 取り下げ対象リスト（quantity=0）のプレビュー
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, current_price, quantity, product_id')
    .eq('user_id', user.id)
    .eq('quantity', 0)

  return NextResponse.json({ items: listings ?? [], count: (listings ?? []).length })
}

// POST: 取り下げ実行
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  // item_ids が指定されていればそのアイテムのみ、なければ全quantity=0
  const itemIds: string[] | undefined = Array.isArray(body.item_ids) ? body.item_ids : undefined

  const db = admin()

  // eBayトークン取得
  const { data: settings } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!settings?.ebay_token) return NextResponse.json({ error: 'eBayトークンが設定されていません' }, { status: 400 })

  const accessToken = await resolveAccessToken(settings as { ebay_token: string; ebay_refresh_token?: string | null; ebay_token_expires_at?: string | null })

  let query = db
    .from('inventory_active_listings')
    .select('ebay_item_id, product_id, quantity')
    .eq('user_id', user.id)
    .eq('quantity', 0)

  if (itemIds) query = query.in('ebay_item_id', itemIds)

  const { data: listings } = await query

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

  // 実行ログを記録
  await db.from('inventory_runs').insert({
    user_id: user.id,
    run_type: 'delist',
    status: failed.length === 0 ? 'completed' : 'partial',
    result_summary: { total: results.length, succeeded, failed: failed.map(f => ({ id: f.itemId, error: f.error })) },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
    // ignore log errors

  return NextResponse.json({ ok: true, total: results.length, succeeded, failed })
}
