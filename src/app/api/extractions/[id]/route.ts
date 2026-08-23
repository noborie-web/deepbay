import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { findBlockedProductDeletions, LISTED_PRODUCT_DELETE_ERROR } from '@/lib/product-deletion'

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

  const force = req.nextUrl.searchParams.get('force') === 'true'
    || (await req.json().catch(() => null) as { force?: unknown } | null)?.force === true

  if (!force) {
    const { data: products, error: productsError } = await admin
      .from('products')
      .select('id, ebay_item_id, ebay_title, original_title')
      .eq('extraction_id', id)
      .eq('user_id', user.id)

    if (productsError) return NextResponse.json({ error: productsError.message }, { status: 500 })

    try {
      const blockedProducts = await findBlockedProductDeletions(admin, user.id, products ?? [])
      if (blockedProducts.length > 0) {
        return NextResponse.json({
          error: LISTED_PRODUCT_DELETE_ERROR,
          blockedProducts,
        }, { status: 409 })
      }
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
    }
  }

  // productsを先に削除（エラーは無視してもよい）
  const { error: prodErr } = await admin.from('products').delete().eq('extraction_id', id)
  if (prodErr) console.warn('products delete warn:', prodErr.message)

  // extractionを削除
  const { error: extErr } = await admin.from('extractions').delete().eq('id', id)
  if (extErr) {
    console.error('extractions delete error:', extErr.message, extErr)
    return NextResponse.json({ error: extErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
