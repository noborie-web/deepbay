import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { addFixedPriceItem, resolveAccessToken } from '@/lib/ebay-actions'

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET: 積み上げ対象リストのプレビュー（new_source_urlが設定されており、is_excluded=falseのsold商品）
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const { data: stackingItems } = await db
    .from('inventory_stacking')
    .select('ebay_item_id, new_source_url')
    .eq('user_id', user.id)
    .eq('is_excluded', false)
    .not('new_source_url', 'is', null)

  if (!stackingItems?.length) return NextResponse.json({ items: [], count: 0 })

  const itemIds = stackingItems.map(s => s.ebay_item_id)
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, current_price, quantity, product_id')
    .eq('user_id', user.id)
    .in('ebay_item_id', itemIds)
    .eq('quantity', 0)

  const listingMap = new Map((listings ?? []).map(l => [l.ebay_item_id, l]))
  const items = stackingItems
    .filter(s => listingMap.has(s.ebay_item_id))
    .map(s => ({
      ebay_item_id: s.ebay_item_id,
      new_source_url: s.new_source_url,
      title: listingMap.get(s.ebay_item_id)?.title,
      current_price: listingMap.get(s.ebay_item_id)?.current_price,
    }))

  return NextResponse.json({ items, count: items.length })
}

// POST: 積み上げ実行（新規出品）
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const itemIds: string[] | undefined = Array.isArray(body.item_ids) ? body.item_ids : undefined

  const db = admin()

  // eBayトークンと出品ポリシー設定を取得
  const { data: settings } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at, payment_profile_name, return_profile_name, shipping_profile_name')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!settings?.ebay_token) return NextResponse.json({ error: 'eBayトークンが設定されていません' }, { status: 400 })
  if (!settings.payment_profile_name || !settings.shipping_profile_name || !settings.return_profile_name) {
    return NextResponse.json({ error: '出品ポリシー（支払い・配送・返品）が設定されていません。設定タブで入力してください。' }, { status: 400 })
  }

  const accessToken = await resolveAccessToken(settings as { ebay_token: string; ebay_refresh_token?: string | null; ebay_token_expires_at?: string | null })

  // 積み上げ対象を取得
  let stackQuery = db
    .from('inventory_stacking')
    .select('ebay_item_id, new_source_url')
    .eq('user_id', user.id)
    .eq('is_excluded', false)
    .not('new_source_url', 'is', null)

  if (itemIds) stackQuery = stackQuery.in('ebay_item_id', itemIds)

  const { data: stackingItems } = await stackQuery
  if (!stackingItems?.length) return NextResponse.json({ ok: true, total: 0, succeeded: 0, failed: [] })

  // 元のリスティング情報とproductを取得
  const ebayItemIds = stackingItems.map(s => s.ebay_item_id)
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, current_price, product_id, quantity')
    .eq('user_id', user.id)
    .in('ebay_item_id', ebayItemIds)
    .eq('quantity', 0)

  const listingMap = new Map((listings ?? []).map(l => [l.ebay_item_id, l]))

  // productのcategory_idを取得
  const productIds = (listings ?? []).filter(l => l.product_id).map(l => l.product_id as string)
  const productMap = new Map<string, { ebay_category_id: string | null; ebay_title: string | null; ebay_price: number | null; description: string | null }>()
  if (productIds.length > 0) {
    const { data: products } = await db
      .from('products')
      .select('id, ebay_category_id, ebay_title, ebay_price, description')
      .in('id', productIds)
    for (const p of products ?? []) productMap.set(p.id, p)
  }

  const results = []
  for (const s of stackingItems) {
    const listing = listingMap.get(s.ebay_item_id)
    if (!listing) continue

    const product = listing.product_id ? productMap.get(listing.product_id) : null
    const title = product?.ebay_title ?? listing.title ?? ''
    const price = product?.ebay_price ?? listing.current_price ?? 0
    const categoryId = product?.ebay_category_id ?? '1'
    const description = product?.description ?? title
    const sku = `stack_${s.ebay_item_id}_${Date.now()}`

    const result = await addFixedPriceItem(accessToken, {
      title,
      price,
      categoryId,
      description,
      pictureUrls: [],
      sku,
      paymentProfileName: settings.payment_profile_name,
      returnProfileName: settings.return_profile_name,
      shippingProfileName: settings.shipping_profile_name,
    })

    results.push({ ebay_item_id: s.ebay_item_id, ...result })

    // 成功したら積み上げ済みとしてマーク（new_source_urlをクリア）
    if (result.success) {
      await db
        .from('inventory_stacking')
        .update({ new_source_url: null, note: `stacked:${result.itemId}`, updated_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('ebay_item_id', s.ebay_item_id)
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).map(r => ({ id: r.ebay_item_id, error: r.error }))

  await db.from('inventory_runs').insert({
    user_id: user.id,
    run_type: 'stack',
    status: failed.length === 0 ? 'completed' : 'partial',
    result_summary: { total: results.length, succeeded, failed },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
    // ignore log errors

  return NextResponse.json({ ok: true, total: results.length, succeeded, failed })
}
