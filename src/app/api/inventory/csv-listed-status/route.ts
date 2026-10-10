import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// ユーザー要望(2026-10-11): 「今後は必ず在庫管理できるようにしてください」
//
// APIでの出品は、eBayがItemIDを返すので出品した瞬間に在庫管理へ登録できる
// (#266)。一方CSV出品(File Exchange)はItemIDが返らないため、Kakehashiは
// 自分が出した出品のItemIDを知る手段がなく、出品時には登録できない。
// そのため在庫管理に載せるには「eBay全体の走査(1万件・未完)」か
// 「Active listingsレポートの取り込み」に頼ることになり、取り込みを忘れると
// 管理外の出品が静かに増える(2026-10-08時点で626件が漏れていた)。
//
// 自動登録は原理的に不可能なので、「漏れたら必ず気づける」ようにする:
// 出品CSVに出したのに在庫管理に入っていない商品を数えて画面に出す。
const CHUNK = 100

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  // CSVで出品した(可能性がある)のに、eBayのItemIDが分かっていない商品
  const { data: candidates, error } = await db
    .from('products')
    .select('id, ebay_title, original_title, listing_csv_exported_at')
    .eq('user_id', user.id)
    .not('listing_csv_exported_at', 'is', null)
    .is('ebay_item_id', null)
    .order('listing_csv_exported_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const ids = (candidates ?? []).map((product) => product.id as string)
  if (ids.length === 0) return NextResponse.json({ pending: 0, items: [], lastExportedAt: null })

  // 在庫管理に既に入っているものは対象外
  const managed = new Set<string>()
  for (let index = 0; index < ids.length; index += CHUNK) {
    const chunk = ids.slice(index, index + CHUNK)
    const { data: rows, error: listingError } = await db
      .from('inventory_active_listings')
      .select('product_id')
      .eq('user_id', user.id)
      .in('product_id', chunk)
    if (listingError) return NextResponse.json({ error: listingError.message }, { status: 500 })
    for (const row of rows ?? []) if (row.product_id) managed.add(row.product_id as string)
  }

  const pendingProducts = (candidates ?? []).filter((product) => !managed.has(product.id as string))

  return NextResponse.json({
    pending: pendingProducts.length,
    lastExportedAt: (pendingProducts[0]?.listing_csv_exported_at as string | null) ?? null,
    // 画面で中身を確認できるよう、先頭だけ返す
    items: pendingProducts.slice(0, 20).map((product) => ({
      id: product.id,
      title: (product.ebay_title as string | null) ?? (product.original_title as string),
      exported_at: product.listing_csv_exported_at,
    })),
  })
}
