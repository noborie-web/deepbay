import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { findBlockedProductDeletions, type BlockedProductDeletion } from '@/lib/product-deletion'

// ユーザー要望: 既存ツール(公式)の抽出一覧と同様、行の「メモ」欄を
// 鉛筆アイコンから直接編集・保存できるようにする。
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { memo?: unknown }
  if (typeof body.memo !== 'string') {
    return NextResponse.json({ error: 'memoは文字列で指定してください' }, { status: 400 })
  }

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { error } = await admin
    .from('extractions')
    .update({ memo: body.memo, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, memo: body.memo })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // 本人の抽出であることを確認
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction } = await (supabase as any)
    .from('extractions')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (!extraction) return NextResponse.json({ error: '抽出が見つかりません' }, { status: 404 })

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // 本番で発生した事故: 抽出の強制削除で出品済み148件の商品と在庫管理の
  // 紐付けが消え、在庫管理が対象0件になった。抽出を削除しても出品済み
  // (eBay ItemID あり/在庫管理に紐付き)の商品は削除せず、抽出から
  // 切り離す(extraction_id = null)だけにする。強制削除(force)は廃止。
  const { data: products, error: productsError } = await admin
    .from('products')
    .select('id, ebay_item_id, ebay_title, original_title')
    .eq('extraction_id', id)
    .eq('user_id', user.id)
  if (productsError) return NextResponse.json({ error: productsError.message }, { status: 500 })

  let keptProducts: BlockedProductDeletion[] = []
  try {
    keptProducts = await findBlockedProductDeletions(admin, user.id, products ?? [])
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
  const keptIds = new Set(keptProducts.map(product => product.id))
  const deletableIds = (products ?? []).map(product => product.id).filter(productId => !keptIds.has(productId))

  if (keptIds.size > 0) {
    const { error: detachError } = await admin
      .from('products')
      .update({ extraction_id: null, updated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .in('id', Array.from(keptIds))
    if (detachError) return NextResponse.json({ error: detachError.message }, { status: 500 })
  }

  if (deletableIds.length > 0) {
    const { error: prodErr } = await admin
      .from('products')
      .delete()
      .eq('user_id', user.id)
      .in('id', deletableIds)
    if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 })
  }

  // extractionを削除
  const { error: extErr } = await admin.from('extractions').delete().eq('id', id)
  if (extErr) {
    console.error('extractions delete error:', extErr.message, extErr)
    return NextResponse.json({ error: extErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, deleted: deletableIds.length, kept: keptProducts })
}