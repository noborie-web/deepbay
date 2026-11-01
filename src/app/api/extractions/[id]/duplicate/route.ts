import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { EBAY_SITES, normalizeSiteKeys } from '@/lib/ebay-sites'
import { fetchJpyRate } from '@/lib/exchange-rate'
import { adjustedJpyRate, loadPricingModel, sitePriceAdjustment } from '@/lib/inventory-pricing'
import { listingPriceForSite, productCustomLabel } from '@/lib/listing-export'
import { convertListingCsv, parseCsvRows } from '@/lib/listing-csv-convert'
import { extractProductIdFromCustomLabel } from '@/lib/inventory'

// ユーザーから実際の工程を教わった(2026-11-01)。
//
//   Kakehashi CSV出力 → specifics-in 取込 → 画像DL → photoroom(白抜き・調整)
//   → watermarkly(透かし) → specifics-in に画像を戻す → 不要画像を目視削除
//   → AIでタイトル・説明・Item Specifics 生成 → コンプライアンスチェック
//   → CSVダウンロード → eBayへアップロード
//
// miyabi-24 と akebono-32 に出すとこの工程を2回繰り返している。アカウントに
// よって変わるのは透かしだけで、白抜き・目視削除・AI生成・コンプライアンス
// チェックは同じ結果になる(AI生成は料金も2倍)。
//
// そこで「出品元の抽出」から一度の操作で済ませる。
//   1. 複製先セラーの商品を用意する(すでにあるものは作らない)
//   2. 仕上げたCSVを受け取り、アカウントで変わる列だけ差し替えて返す
//
// CSVを渡さなければ 1 だけを行う(複製だけしたいとき)。
export const maxDuration = 60

// 1回のinsertに渡す件数。ペイロードが大きくなりすぎないようにする。
const CHUNK_SIZE = 100
// 完成CSVは商品説明にHTMLが入るので大きい。135件で約1.9MB。
const MAX_CSV_BYTES = 30 * 1024 * 1024

// 複製時に引き継がない列。出品の結果と、その抽出に固有の記録。
// (ここに挙げていない列はそのまま引き継ぐ。商品の中身は同じものを出すため)
const RESET_COLUMNS = {
  ebay_item_id: null,
  listing_status: 'draft',
  listed_at: null,
  sold_at: null,
  listing_csv_exported_at: null,
  listing_csv_unlisted_confirmed_at: null,
} as const

interface TargetProduct {
  id: string
  source_url: string
  ebay_price: number | null
  pricing_jpy_per_usd: number | null
}

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

/**
 * 複製先セラーが既に持っている商品を、仕入先URLで引く。
 *
 * 同じ操作を2回実行しても商品が二重に増えないようにするため、抽出単位ではなく
 * 「そのセラーの商品すべて」から探す。抽出同士の対応を別に持たずに済む。
 */
async function findExistingTargets(
  db: SupabaseClient,
  userId: string,
  sellerAccountId: string,
  sourceUrls: string[],
): Promise<Map<string, TargetProduct>> {
  const found = new Map<string, TargetProduct>()
  for (let index = 0; index < sourceUrls.length; index += CHUNK_SIZE) {
    const chunk = sourceUrls.slice(index, index + CHUNK_SIZE)
    const { data, error } = await db
      .from('products')
      .select('id, source_url, ebay_price, pricing_jpy_per_usd, extractions!inner(seller_account_id)')
      .eq('user_id', userId)
      .eq('extractions.seller_account_id', sellerAccountId)
      .in('source_url', chunk)
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as unknown as TargetProduct[]) {
      // 同じ仕入先URLが複数あれば最初の1件を使う(どれも同じ商品)
      if (!found.has(row.source_url)) found.set(row.source_url, row)
    }
  }
  return found
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    sellerAccountId?: string
    name?: string
    csv?: string
    site?: string
    paymentProfile?: string
    returnProfile?: string
    shippingProfile?: string
  }
  const sellerAccountId = body.sellerAccountId?.trim()
  if (!sellerAccountId) {
    return NextResponse.json({ error: '出品先のセラーを選択してください' }, { status: 400 })
  }

  const csv = body.csv ?? ''
  const wantsCsv = csv.trim().length > 0
  if (wantsCsv && csv.length > MAX_CSV_BYTES) {
    return NextResponse.json({ error: 'CSVが大きすぎます' }, { status: 413 })
  }
  const payment = body.paymentProfile?.trim() ?? ''
  const returnProfile = body.returnProfile?.trim() ?? ''
  const shipping = body.shippingProfile?.trim() ?? ''
  if (wantsCsv && (!payment || !returnProfile || !shipping)) {
    return NextResponse.json({ error: '配送・支払・返品ポリシーをすべて入力してください' }, { status: 400 })
  }
  const siteKey = normalizeSiteKeys(body.site)[0]
  const site = EBAY_SITES[siteKey]

  const db = admin()

  const { data: source, error: sourceError } = await db
    .from('extractions')
    .select('id, user_id, source_url, source_site, seller_account_id, category_id, bulk_edit_setting_id, memo, is_bulk, name')
    .eq('id', extractionId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (sourceError) return NextResponse.json({ error: sourceError.message }, { status: 500 })
  if (!source) return NextResponse.json({ error: '抽出が見つかりません' }, { status: 404 })

  const { data: seller, error: sellerError } = await db
    .from('seller_accounts')
    .select('id, seller_id, display_name')
    .eq('id', sellerAccountId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (sellerError) return NextResponse.json({ error: sellerError.message }, { status: 500 })
  if (!seller) return NextResponse.json({ error: '出品セラーが見つかりません' }, { status: 404 })
  if (source.seller_account_id === sellerAccountId) {
    return NextResponse.json({ error: '抽出と同じ出品セラーには出せません' }, { status: 422 })
  }

  // 元の商品。1,000行で打ち切られるのでページ送りする(#db-query-safety)
  const sourceProducts: Array<Record<string, unknown>> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('user_id', user.id)
      .eq('extraction_id', extractionId)
      .order('id')
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    sourceProducts.push(...(data ?? []))
    if ((data?.length ?? 0) < 1000) break
  }
  if (sourceProducts.length === 0) {
    return NextResponse.json({ error: 'この抽出には商品がありません' }, { status: 422 })
  }

  const sourceUrls = Array.from(new Set(sourceProducts.map(p => String(p.source_url))))
  let existing: Map<string, TargetProduct>
  try {
    existing = await findExistingTargets(db, user.id, sellerAccountId, sourceUrls)
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }

  // まだ無い商品だけ作る(2回実行しても増えない)
  const missing = sourceProducts.filter(p => !existing.has(String(p.source_url)))
  let createdExtractionId: string | null = null
  if (missing.length > 0) {
    const sellerLabel = seller.display_name?.trim() || seller.seller_id
    const { data: created, error: createError } = await db
      .from('extractions')
      .insert({
        user_id: user.id,
        source_url: source.source_url,
        source_site: source.source_site,
        seller_account_id: sellerAccountId,
        category_id: source.category_id,
        bulk_edit_setting_id: source.bulk_edit_setting_id,
        memo: source.memo ?? '',
        is_bulk: source.is_bulk,
        name: body.name?.trim() || `${source.name ?? '抽出'}（${sellerLabel}）`,
        // 抽出そのものは実行しない。商品は複製で入るので完了として作る。
        status: 'completed',
        progress: 100,
        extracted_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (createError) return NextResponse.json({ error: createError.message }, { status: 500 })
    createdExtractionId = created.id as string

    const rows = missing.map(product => {
      const copy: Record<string, unknown> = { ...product, ...RESET_COLUMNS }
      // 新しいIDを採番する(CustomLabel が別物になる)
      delete copy.id
      delete copy.created_at
      delete copy.updated_at
      copy.extraction_id = createdExtractionId
      return copy
    })
    for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
      const chunk = rows.slice(index, index + CHUNK_SIZE)
      const { data, error } = await db
        .from('products')
        .insert(chunk)
        .select('id, source_url, ebay_price, pricing_jpy_per_usd')
      if (error) {
        // 途中で失敗したら、作りかけの抽出ごと片付ける(中途半端に残さない)
        await db.from('products').delete().eq('user_id', user.id).eq('extraction_id', createdExtractionId)
        await db.from('extractions').delete().eq('id', createdExtractionId).eq('user_id', user.id)
        return NextResponse.json({ error: `商品を複製できませんでした: ${error.message}` }, { status: 500 })
      }
      for (const row of (data ?? []) as TargetProduct[]) existing.set(row.source_url, row)
    }
  }

  if (!wantsCsv) {
    return NextResponse.json({
      ok: true,
      extraction_id: createdExtractionId,
      seller_id: seller.seller_id,
      created: missing.length,
      reused: sourceProducts.length - missing.length,
    })
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

  // CSVのCustomLabel(元の商品)から、複製先の商品へ対応付ける。
  // 商品説明のHTMLにも kakehashi_ が現れうるので、行の検索ではなく列で読む。
  const sourceUrlById = new Map(sourceProducts.map(p => [String(p.id), String(p.source_url)]))
  const rows = parseCsvRows(csv)
  const labelIndex = (rows[0] ?? []).map(header => header.trim()).indexOf('CustomLabel')
  if (labelIndex < 0) {
    return NextResponse.json({ error: 'CSVに CustomLabel 列が見つかりません' }, { status: 422 })
  }
  const replacements = new Map<string, { customLabel: string; startPrice: number }>()
  for (const row of rows.slice(1)) {
    if (row.length <= labelIndex) continue
    const label = row[labelIndex].trim()
    const sourceId = extractProductIdFromCustomLabel(label)
    if (!sourceId) continue
    const sourceUrl = sourceUrlById.get(sourceId)
    if (!sourceUrl) continue
    const target = existing.get(sourceUrl)
    if (!target) continue
    replacements.set(label, {
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
      extraction_id: createdExtractionId,
      seller_id: seller.seller_id,
      created: missing.length,
      reused: sourceProducts.length - missing.length,
      csv: result.csv,
      converted: result.converted,
      skipped: result.skipped,
      site: siteKey,
      currency: site.currency,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })
  }
}
