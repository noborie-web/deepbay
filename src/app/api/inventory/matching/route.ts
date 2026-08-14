import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function getUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = request.nextUrl.searchParams.get('q')?.trim().slice(0, 100) ?? ''
  if (!q) return NextResponse.json({ products: [] })
  const pattern = `%${q.replace(/[(),]/g, ' ')}%`
  const { data, error } = await admin()
    .from('products')
    .select('id, source_item_id, source_url, original_title, original_images, ebay_item_id')
    .eq('user_id', user.id)
    .or(`source_item_id.ilike.${pattern},original_title.ilike.${pattern},source_url.ilike.${pattern}`)
    .order('updated_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ products: data ?? [] })
}

export async function POST(request: NextRequest) {
  const user = await getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null) as { listingId?: string; productId?: string } | null
  const listingId = body?.listingId?.trim()
  const productId = body?.productId?.trim()
  if (!listingId || !productId) return NextResponse.json({ error: 'listingId and productId are required' }, { status: 400 })

  const db = admin()
  const { data: listing, error: listingError } = await db
    .from('inventory_active_listings')
    .select('id, ebay_item_id, user_id')
    .eq('id', listingId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (listingError) return NextResponse.json({ error: listingError.message }, { status: 500 })
  if (!listing) return NextResponse.json({ error: 'Listing not found' }, { status: 404 })

  const { data: product, error: productError } = await db
    .from('products')
    .select('id, user_id, ebay_item_id')
    .eq('id', productId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (productError) return NextResponse.json({ error: productError.message }, { status: 500 })
  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  if (product.ebay_item_id && product.ebay_item_id !== listing.ebay_item_id) {
    return NextResponse.json({ error: 'このDeepBay商品には別のeBay商品IDが登録されています' }, { status: 409 })
  }

  const { data: duplicate } = await db
    .from('products')
    .select('id')
    .eq('user_id', user.id)
    .eq('ebay_item_id', listing.ebay_item_id)
    .neq('id', productId)
    .maybeSingle()
  if (duplicate) return NextResponse.json({ error: 'このeBay商品IDは別の商品に紐付いています' }, { status: 409 })

  const { error: updateProductError } = await db
    .from('products')
    .update({ ebay_item_id: listing.ebay_item_id, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .eq('user_id', user.id)
  if (updateProductError) return NextResponse.json({ error: updateProductError.message }, { status: 500 })

  const { error: updateListingError } = await db
    .from('inventory_active_listings')
    .update({ product_id: productId })
    .eq('id', listingId)
    .eq('user_id', user.id)
  if (updateListingError) return NextResponse.json({ error: updateListingError.message }, { status: 500 })

  return NextResponse.json({ ok: true, listingId, productId, ebayItemId: listing.ebay_item_id })
}
