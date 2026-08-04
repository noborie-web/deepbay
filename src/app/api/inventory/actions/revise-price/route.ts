import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { revisePrice, resolveAccessToken } from '@/lib/ebay-actions'

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET: 価格改定対象リストのプレビュー
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, current_price, product_id')
    .eq('user_id', user.id)
    .not('product_id', 'is', null)

  const productIds = (listings ?? []).map(l => l.product_id as string)
  const productMap = new Map<string, { ebay_price: number | null }>()

  if (productIds.length > 0) {
    const { data: products } = await db
      .from('products')
      .select('id, ebay_price')
      .in('id', productIds)
    for (const p of products ?? []) productMap.set(p.id, p)
  }

  const items = (listings ?? [])
    .filter(l => {
      const p = productMap.get(l.product_id!)
      if (!p?.ebay_price || !l.current_price) return false
      return Math.abs(p.ebay_price - l.current_price) > 0.5
    })
    .map(l => {
      const p = productMap.get(l.product_id!)!
      return {
        ebay_item_id: l.ebay_item_id,
        title: l.title,
        old_price: l.current_price,
        new_price: p.ebay_price,
        diff: Math.round((p.ebay_price! - l.current_price!) * 100) / 100,
      }
    })

  return NextResponse.json({ items, count: items.length })
}

// POST: 価格改定実行
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const itemIds: string[] | undefined = Array.isArray(body.item_ids) ? body.item_ids : undefined

  const db = admin()

  const { data: settings } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!settings?.ebay_token) return NextResponse.json({ error: 'eBayトークンが設定されていません' }, { status: 400 })

  const accessToken = await resolveAccessToken(settings as { ebay_token: string; ebay_refresh_token?: string | null; ebay_token_expires_at?: string | null })

  let query = db
    .from('inventory_active_listings')
    .select('ebay_item_id, current_price, product_id')
    .eq('user_id', user.id)
    .not('product_id', 'is', null)

  if (itemIds) query = query.in('ebay_item_id', itemIds)

  const { data: listings } = await query

  const productIds = (listings ?? []).map(l => l.product_id as string)
  const productMap = new Map<string, { ebay_price: number | null }>()
  if (productIds.length > 0) {
    const { data: products } = await db.from('products').select('id, ebay_price').in('id', productIds)
    for (const p of products ?? []) productMap.set(p.id, p)
  }

  const results = []
  for (const l of listings ?? []) {
    const p = productMap.get(l.product_id!)
    if (!p?.ebay_price || !l.current_price) continue
    if (Math.abs(p.ebay_price - l.current_price) <= 0.5) continue
    const result = await revisePrice(accessToken, l.ebay_item_id, p.ebay_price)
    results.push(result)
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)

  await db.from('inventory_runs').insert({
    user_id: user.id,
    run_type: 'revise_price',
    status: failed.length === 0 ? 'completed' : 'partial',
    result_summary: { total: results.length, succeeded, failed: failed.map(f => ({ id: f.itemId, error: f.error })) },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
    // ignore log errors

  return NextResponse.json({ ok: true, total: results.length, succeeded, failed })
}
