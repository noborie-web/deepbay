import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// ユーザー要望(2026-11-01): miyabi-24(US)に出した商品を akebono-32(UK)にも
// 出して時間を短縮したい。
//
// 出来上がったCSVを手で書き換える方法は、為替レートと価格調整がその時点の値で
// 固定され、ビジネスポリシーも手入力になる。CSV出力(/api/csv)は既に
// sites=US,UK,AU に対応していて、レート・価格調整・サイトごとのポリシーを
// 正しく入れてくれるので、そちらに載せる。
//
// 載せるために必要なのは「この抽出の商品を、別のセラーの抽出として複製する」
// 一点だけ。商品を複製すると商品IDが変わるので、CustomLabel
// (kakehashi_{商品ID})も自動的に別物になり、在庫管理も出品ごとに正しく効く。
// 同じ商品IDのまま2アカウントに出すと、products.ebay_item_id と listing_status が
// 単一値のため、後から同期した方で上書きされて管理できない。
//
// 仕入先URLは同じままなので、仕入先が売り切れれば両方とも取り下げられる。
export const maxDuration = 60

// 1回のinsertに渡す件数。URLやペイロードが大きくなりすぎないようにする。
const CHUNK_SIZE = 100

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

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { sellerAccountId?: string; name?: string }
  const sellerAccountId = body.sellerAccountId?.trim()
  if (!sellerAccountId) {
    return NextResponse.json({ error: '複製先の出品セラーを選択してください' }, { status: 400 })
  }

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
    return NextResponse.json({ error: '同じ出品セラーには複製できません' }, { status: 422 })
  }

  // 商品は1,000行で打ち切られるのでページ送りで全件引く(#db-query-safety)
  const products: Array<Record<string, unknown>> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('products')
      .select('*')
      .eq('user_id', user.id)
      .eq('extraction_id', extractionId)
      .order('id')
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    products.push(...(data ?? []))
    if ((data?.length ?? 0) < 1000) break
  }
  if (products.length === 0) {
    return NextResponse.json({ error: 'この抽出には商品がありません' }, { status: 422 })
  }

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
      // 抽出そのものは実行しない。商品は複製で入るので、完了として作る。
      status: 'completed',
      progress: 100,
      extracted_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (createError) return NextResponse.json({ error: createError.message }, { status: 500 })
  const newExtractionId = created.id as string

  const rows = products.map(product => {
    const copy: Record<string, unknown> = { ...product, ...RESET_COLUMNS }
    // 新しいIDを採番する(CustomLabel が別物になる)
    delete copy.id
    delete copy.created_at
    delete copy.updated_at
    copy.extraction_id = newExtractionId
    return copy
  })

  let inserted = 0
  for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
    const chunk = rows.slice(index, index + CHUNK_SIZE)
    const { data, error } = await db.from('products').insert(chunk).select('id')
    if (error) {
      // 途中で失敗したら、作りかけの抽出ごと片付ける(中途半端に残さない)
      await db.from('products').delete().eq('user_id', user.id).eq('extraction_id', newExtractionId)
      await db.from('extractions').delete().eq('id', newExtractionId).eq('user_id', user.id)
      return NextResponse.json({ error: `商品を複製できませんでした: ${error.message}` }, { status: 500 })
    }
    inserted += data?.length ?? 0
  }

  return NextResponse.json({
    ok: true,
    extraction_id: newExtractionId,
    seller_id: seller.seller_id,
    products: inserted,
  })
}
