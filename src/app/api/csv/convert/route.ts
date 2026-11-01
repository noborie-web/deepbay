import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { EBAY_SITES, normalizeSiteKeys } from '@/lib/ebay-sites'
import { fetchJpyRate } from '@/lib/exchange-rate'
import { adjustedJpyRate, loadPricingModel, sitePriceAdjustment } from '@/lib/inventory-pricing'
import { listingPriceForSite, productCustomLabel } from '@/lib/listing-export'
import { convertListingCsv, parseCsvRows } from '@/lib/listing-csv-convert'
import { extractProductIdFromCustomLabel } from '@/lib/inventory'

// ユーザー要望(2026-11-01): miyabi-24(US)と akebono-32(UK)に同じ商品を出す際、
// specifics-in での白抜き・目視削除・AI生成・コンプライアンスチェックを
// 2回繰り返している。アカウントで変わるのは透かしだけなので、完成したCSVを
// 受け取り、アカウントによって変わる列だけ差し替えて返す。
//
// Title / Description / C:*(Item Specifics) / Category / PicURL は触らない。
// AI生成の結果を作り直さないことが目的のため。
export const maxDuration = 60

// 完成CSVは商品説明にHTMLが入るので大きい。135件で約1.9MB。
const MAX_CSV_BYTES = 30 * 1024 * 1024

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    csv?: string
    targetExtractionId?: string
    site?: string
    paymentProfile?: string
    returnProfile?: string
    shippingProfile?: string
  }

  const csv = body.csv ?? ''
  if (!csv.trim()) return NextResponse.json({ error: 'CSVの中身がありません' }, { status: 400 })
  if (csv.length > MAX_CSV_BYTES) {
    return NextResponse.json({ error: 'CSVが大きすぎます' }, { status: 413 })
  }
  const targetExtractionId = body.targetExtractionId?.trim()
  if (!targetExtractionId) {
    return NextResponse.json({ error: '複製先の抽出を選択してください' }, { status: 400 })
  }
  const payment = body.paymentProfile?.trim() ?? ''
  const returnProfile = body.returnProfile?.trim() ?? ''
  const shipping = body.shippingProfile?.trim() ?? ''
  if (!payment || !returnProfile || !shipping) {
    return NextResponse.json({ error: '配送・支払・返品ポリシーをすべて入力してください' }, { status: 400 })
  }
  const siteKey = normalizeSiteKeys(body.site)[0]
  const site = EBAY_SITES[siteKey]

  const db = admin()

  const { data: extraction, error: extractionError } = await db
    .from('extractions')
    .select('id, seller_account_id')
    .eq('id', targetExtractionId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (extractionError) return NextResponse.json({ error: extractionError.message }, { status: 500 })
  if (!extraction) return NextResponse.json({ error: '複製先の抽出が見つかりません' }, { status: 404 })

  // 複製先の商品。元の商品とは source_url で突き合わせる(複製は同じ仕入先URLを
  // 引き継ぐため)。1,000行で打ち切られるのでページ送りする(#db-query-safety)
  const targets: Array<{ id: string; source_url: string; ebay_price: number | null; pricing_jpy_per_usd: number | null }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('products')
      .select('id, source_url, ebay_price, pricing_jpy_per_usd')
      .eq('user_id', user.id)
      .eq('extraction_id', targetExtractionId)
      .order('id')
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    targets.push(...(data ?? []))
    if ((data?.length ?? 0) < 1000) break
  }
  if (targets.length === 0) {
    return NextResponse.json({ error: '複製先の抽出に商品がありません' }, { status: 422 })
  }
  const targetBySourceUrl = new Map(targets.map(product => [product.source_url, product]))

  // CSVのCustomLabel列から元の商品IDを取り出し、その仕入先URLを引く。
  // 商品説明のHTMLにも kakehashi_ が現れうるので、行の検索ではなく列で読む。
  const rows = parseCsvRows(csv)
  const labelIndex = (rows[0] ?? []).map(header => header.trim()).indexOf('CustomLabel')
  if (labelIndex < 0) {
    return NextResponse.json({ error: 'CustomLabel 列が見つかりません' }, { status: 422 })
  }
  const sourceIds = Array.from(new Set(
    rows.slice(1)
      .map(row => (row.length > labelIndex ? extractProductIdFromCustomLabel(row[labelIndex].trim()) : null))
      .filter((id): id is string => id !== null),
  ))
  if (sourceIds.length === 0) {
    return NextResponse.json({ error: 'CSVにKakehashiのCustomLabelが見つかりません' }, { status: 422 })
  }
  const sourceById = new Map<string, string>()
  for (let index = 0; index < sourceIds.length; index += 100) {
    const chunk = sourceIds.slice(index, index + 100)
    const { data, error } = await db
      .from('products')
      .select('id, source_url')
      .eq('user_id', user.id)
      .in('id', chunk)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const product of data ?? []) sourceById.set(product.id, product.source_url)
  }

  // 価格は出品先サイトの通貨で計算し直す。CSVのUSD値を単純換算するのではなく、
  // CSV出力(/api/csv)と同じ計算(実レート + 円高調整 + 関税調整)を使う。
  const pricingModel = await loadPricingModel(db, user.id)
  const rawUsdRate = await fetchJpyRate('USD').then(r => r.rate).catch(() => 0)
  let jpyPerCurrency = rawUsdRate
  try {
    const { rate } = await fetchJpyRate(site.currency)
    jpyPerCurrency = adjustedJpyRate(pricingModel, site.currency, rate, rawUsdRate)
  } catch (error) {
    return NextResponse.json({
      error: `${site.currency}の為替レートを取得できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    }, { status: 502 })
  }
  const fallbackJpyPerUsd = adjustedJpyRate(pricingModel, 'USD', rawUsdRate, rawUsdRate)
  // USはCSV出力と同じく換算しない(出品価格をそのまま使う)
  const priceSite = siteKey === 'US' ? undefined : {
    siteId: site.siteId,
    currency: site.currency,
    jpyPerCurrency,
    fallbackJpyPerUsd,
    priceAdjustment: sitePriceAdjustment(pricingModel, site.siteId),
  }

  const replacements = new Map<string, { customLabel: string; startPrice: number }>()
  for (const [sourceId, sourceUrl] of sourceById) {
    const target = targetBySourceUrl.get(sourceUrl)
    if (!target) continue
    replacements.set(productCustomLabel({ id: sourceId }), {
      customLabel: productCustomLabel({ id: target.id }),
      startPrice: listingPriceForSite(target, priceSite),
    })
  }

  try {
    const result = convertListingCsv(csv, {
      siteId: site.siteId,
      currency: site.currency,
      policies: { payment, return: returnProfile, shipping },
      replacements,
    })
    return NextResponse.json({
      ok: true,
      csv: result.csv,
      converted: result.converted,
      skipped: result.skipped,
      site: siteKey,
      currency: site.currency,
      jpy_per_currency: jpyPerCurrency,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })
  }
}
