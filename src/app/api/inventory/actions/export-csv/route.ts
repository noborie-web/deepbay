import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { buildEndCsvFiles, buildReviseCsvFiles } from '@/lib/inventory-action-csv'
import { resolveDelistEligibility } from '@/lib/inventory-delist'
import { adjustedJpyRate, loadPricingModel, sitePriceAdjustment } from '@/lib/inventory-pricing'
import { decideSiteRevisePrice, loadJpyRates } from '@/lib/inventory-site-pricing'

// ユーザー要望(2026-09-27): APIの呼び出し上限に達すると価格改定も取り下げも
// 実行できない。CSVを出してeBay(File Exchange)にアップロードすれば、
// Kakehashiの API枠を使わずに反映できる。対象の決め方はAPI実行と同じにして、
// 「画面の件数」と「CSVの件数」が食い違わないようにする。
function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const kind = req.nextUrl.searchParams.get('kind')
  if (kind !== 'revise' && kind !== 'end') {
    return NextResponse.json({ error: 'kind は revise か end で指定してください' }, { status: 400 })
  }

  const db = admin()
  const { data: sellers } = await db
    .from('seller_accounts')
    .select('id, seller_id, display_name, is_default')
    .eq('user_id', user.id)
  const sellerNames = new Map((sellers ?? []).map(row => [row.id as string, row.seller_id as string]))
  const defaultSeller = (sellers ?? []).find(row => row.is_default)?.seller_id
    ?? (sellers ?? [])[0]?.seller_id
    ?? 'kakehashi'

  if (kind === 'end') {
    const { data: settings, error: settingsError } = await db
      .from('inventory_settings')
      .select('days_until_delist, delist_by_age_enabled, delist_on_sold_out')
      .eq('user_id', user.id)
      .maybeSingle()
    if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })

    const eligibility = resolveDelistEligibility(settings)
    if (!eligibility.enabled) return NextResponse.json({ files: [], count: 0, disabled: true })

    let query = db
      .from('inventory_active_listings')
      .select('ebay_item_id, site_id, seller_account_id')
      .eq('user_id', user.id)
      .not('product_id', 'is', null)
      .eq('quantity', 0)
      .is('delisted_at', null)
    if (eligibility.cutoffIso) query = query.lte('start_time', eligibility.cutoffIso)
    const { data: listings, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const files = buildEndCsvFiles(
      (listings ?? []).map(l => ({ ebayItemId: l.ebay_item_id as string, siteId: (l.site_id as string | null) ?? 'US' })),
      sellerNames.get((listings ?? [])[0]?.seller_account_id as string) ?? defaultSeller,
    )
    return NextResponse.json({ files, count: files.reduce((sum, f) => sum + f.rows, 0) })
  }

  const { data: listings, error } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, current_price, product_id, seller_account_id, site_id, currency')
    .eq('user_id', user.id)
    .not('product_id', 'is', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const productIds = (listings ?? []).map(l => l.product_id as string)
  const productMap = new Map<string, { ebay_price: number | null; pricing_jpy_per_usd: number | null }>()
  if (productIds.length > 0) {
    const { data: products } = await db
      .from('products')
      .select('id, ebay_price, pricing_jpy_per_usd')
      .in('id', productIds)
    for (const p of products ?? []) productMap.set(p.id, p)
  }

  const pricingModel = await loadPricingModel(db, user.id)
  const rates = await loadJpyRates(
    (listings ?? []).map(l => ((l.currency as string | null) ?? 'USD')),
    (currency, rate, jpyPerUsd) => adjustedJpyRate(pricingModel, currency, rate, jpyPerUsd),
  )

  const rows = (listings ?? []).flatMap(l => {
    const product = productMap.get(l.product_id as string)
    const currency = ((l.currency as string | null) ?? 'USD').toUpperCase()
    const decision = decideSiteRevisePrice({
      currentPrice: l.current_price as number | null,
      usdPrice: product?.ebay_price ?? null,
      jpyPerUsd: product?.pricing_jpy_per_usd ?? null,
      siteId: (l.site_id as string | null) ?? 'US',
      jpyPerCurrency: rates.get(currency) ?? null,
      priceAdjustment: sitePriceAdjustment(pricingModel, (l.site_id as string | null) ?? 'US'),
    })
    if (decision.action !== 'revise') return []
    return [{ ebayItemId: l.ebay_item_id as string, price: decision.price, siteId: (l.site_id as string | null) ?? 'US' }]
  })

  const files = buildReviseCsvFiles(
    rows,
    sellerNames.get((listings ?? [])[0]?.seller_account_id as string) ?? defaultSeller,
  )
  return NextResponse.json({ files, count: files.reduce((sum, f) => sum + f.rows, 0) })
}
