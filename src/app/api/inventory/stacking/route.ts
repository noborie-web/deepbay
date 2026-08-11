import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// GET: quantity=0のアクティブリスティング一覧（積み上げ候補）
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()

  const [listingsResult, stackingResult] = await Promise.all([
    db.from('inventory_active_listings')
      .select('id, ebay_item_id, title, custom_label, current_price, quantity, listing_status, start_time, product_id, fetched_at')
      .eq('user_id', user.id)
      .eq('quantity', 0)
      .order('fetched_at', { ascending: false })
      .limit(500),
    db.from('inventory_stacking')
      .select('*')
      .eq('user_id', user.id),
  ])

  const stackingMap = new Map<string, { new_source_url: string | null; is_excluded: boolean }>(
    (stackingResult.data ?? []).map(s => [s.ebay_item_id, s])
  )

  const productIds = (listingsResult.data ?? [])
    .filter(l => l.product_id)
    .map(l => l.product_id as string)

  const productMap = new Map<string, { source_url: string | null; original_images: string[] }>()
  if (productIds.length > 0) {
    const { data: products } = await db
      .from('products')
      .select('id, source_url, original_images')
      .in('id', productIds)
    for (const p of products ?? []) {
      productMap.set(p.id, { source_url: p.source_url, original_images: p.original_images })
    }
  }

  const items = (listingsResult.data ?? [])
    .filter(l => {
      const s = stackingMap.get(l.ebay_item_id)
      return !s?.is_excluded
    })
    .map(l => {
      const s = stackingMap.get(l.ebay_item_id)
      const product = l.product_id ? productMap.get(l.product_id) : null
      return {
        ...l,
        source_url: product?.source_url ?? null,
        image_url: product?.original_images?.[0] ?? null,
        new_source_url: s?.new_source_url ?? null,
        in_stacking: !!s,
      }
    })

  return NextResponse.json({ items })
}

// POST: 積み上げエントリを追加/更新
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.ebay_item_id) return NextResponse.json({ error: 'ebay_item_idが必要です' }, { status: 400 })

  const { error } = await admin()
    .from('inventory_stacking')
    .upsert({
      user_id: user.id,
      ebay_item_id: body.ebay_item_id,
      new_source_url: body.new_source_url ?? null,
      note: body.note ?? null,
      is_excluded: false,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,ebay_item_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE: 積み上げから除外（is_excluded=true）
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ebay_item_id } = await req.json().catch(() => ({}))
  if (!ebay_item_id) return NextResponse.json({ error: 'ebay_item_idが必要です' }, { status: 400 })

  const { error } = await admin()
    .from('inventory_stacking')
    .upsert({
      user_id: user.id,
      ebay_item_id,
      is_excluded: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,ebay_item_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
