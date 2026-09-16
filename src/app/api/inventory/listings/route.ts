import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { fetchUsdJpyRate } from '@/lib/exchange-rate'
import { calcListingProfit, loadPricingModel } from '@/lib/inventory-pricing'

const PAGE_SIZE = 50

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const requestedPage = Number(request.nextUrl.searchParams.get('page') ?? '1')
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const rawSearch = request.nextUrl.searchParams.get('q')?.trim().slice(0, 100) ?? ''
  // Supabase's `or` filter uses commas and parentheses as syntax. Replacing
  // those characters keeps a user-entered search term inside the value.
  const search = rawSearch.replace(/[(),]/g, ' ').trim()
  const from = (page - 1) * PAGE_SIZE

  // ユーザー要望: 在庫管理画面上部の集計カード(出品中・売却済み)を
  // クリックしたら、このeBay商品一覧タブも同じ条件で絞り込みたい。
  // 同期対象は既にeBayの「Active」出品のみなので、在庫数(quantity)の
  // 有無で判定する: 残数が1以上あれば出品中、0なら売り切れとみなす
  // (checkSupplierListingsが仕入れ元売り切れ時にquantityを0にする挙動
  // と同じ基準)。「下書き」はeBayに出品済みのActiveリストという性質上
  // 該当が存在しないため、呼び出し元(フロント)でAPIを呼ばず空表示にする。
  const status = request.nextUrl.searchParams.get('status')

  let query = admin()
    .from('inventory_active_listings')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)

  if (status === 'listed') query = query.gt('quantity', 0)
  if (status === 'sold') query = query.eq('quantity', 0).gt('quantity_sold', 0)
  // 取下げ: 残数0で販売なし(仕入先売り切れの即取り下げ等でeBayの数量を0にしたもの)
  if (status === 'delisted') query = query.eq('quantity', 0).or('quantity_sold.is.null,quantity_sold.eq.0')

  if (search) {
    const pattern = `%${search}%`
    query = query.or([
      `ebay_item_id.ilike.${pattern}`,
      `title.ilike.${pattern}`,
      `custom_label.ilike.${pattern}`,
    ].join(','))
  }

  const { data, error, count } = await query
    .order('fetched_at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Page-scoped filtering of `listings` only reveals unmatched items on the
  // current page. Count the true total across all pages separately so the UI
  // can show an accurate "全体で未一致 N 件" figure instead of a per-page one.
  const { count: unmatchedTotal, error: unmatchedError } = await admin()
    .from('inventory_active_listings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('product_id', null)

  if (unmatchedError) return NextResponse.json({ error: unmatchedError.message }, { status: 500 })

  // ユーザー要望: 同期済みeBay Active商品に仕入値と利益額を表示する。
  // 紐付いた商品の仕入価格(未記録なら抽出時の価格)と、ユーザーの価格
  // モデル(段階利益設定)・現在の為替から利益額を計算して付加する。
  const rows = (data ?? []) as Array<Record<string, unknown>>
  const productIds = rows.map(row => row.product_id).filter((id): id is string => typeof id === 'string')
  let enriched = rows
  if (productIds.length > 0) {
    const [productsResult, pricingModel, rate] = await Promise.all([
      admin().from('products').select('id, purchase_price_jpy, original_price').in('id', productIds),
      loadPricingModel(admin(), user.id),
      fetchUsdJpyRate().catch(() => null),
    ])
    const productMap = new Map<string, { purchase_price_jpy: number | null; original_price: number | null }>()
    for (const product of productsResult.data ?? []) productMap.set(product.id, product)
    enriched = rows.map(row => {
      const product = typeof row.product_id === 'string' ? productMap.get(row.product_id) : undefined
      const purchasePriceJpy = product?.purchase_price_jpy ?? product?.original_price ?? null
      const price = typeof row.current_price === 'number' ? row.current_price : Number(row.current_price)
      const profit = purchasePriceJpy !== null && rate && price > 0
        ? calcListingProfit(pricingModel, price, purchasePriceJpy, rate.rate)
        : null
      return {
        ...row,
        purchase_price_jpy: purchasePriceJpy,
        profit_usd: profit?.profitUsd ?? null,
        profit_jpy: profit?.profitJpy ?? null,
      }
    })
  }

  const total = count ?? 0
  return NextResponse.json({
    listings: enriched,
    total,
    unmatchedTotal: unmatchedTotal ?? 0,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  })
}
