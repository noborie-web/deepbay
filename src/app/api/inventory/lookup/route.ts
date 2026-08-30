import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { extractProductIdFromCustomLabel, extractSourceLookupCode } from '@/lib/inventory'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const code = req.nextUrl.searchParams.get('code')?.trim() ?? ''
  if (!code) return NextResponse.json({ error: 'codeパラメータが必要です' }, { status: 400 })

  const db = admin()

  // 現在の出品エクスポーター(listing-export.ts の productCustomLabel)が発行する
  // CustomLabelは "deepbay_<商品UUID(-を_に置換)>" 形式で、商品IDそのものを直接
  // 復元できる。以前は "ele_YYYYMMDD_<UUID>" 形式(source_item_idと照合)のみに
  // 対応しており、現行形式のDBK-IDを貼り付けても常に「見つかりませんでした」に
  // なっていた。まず現行形式で商品IDを直接引き当て、見つからなければ旧形式
  // (source_item_id照合)にフォールバックする。
  const directProductId = extractProductIdFromCustomLabel(code)
  if (directProductId) {
    const { data, error } = await db
      .from('products')
      .select('id, source_url, original_title')
      .eq('user_id', user.id)
      .eq('id', directProductId)
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (data) {
      return NextResponse.json({
        found: true,
        source_url: data.source_url,
        title: data.original_title,
        product_id: data.id,
      })
    }
  }

  const lookupCode = extractSourceLookupCode(code) ?? code

  const { data, error } = await db
    .from('products')
    .select('id, source_url, original_title, source_item_id')
    .eq('user_id', user.id)
    .eq('source_item_id', lookupCode)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ found: false, source_url: null })

  return NextResponse.json({
    found: true,
    source_url: data.source_url,
    title: data.original_title,
    product_id: data.id,
  })
}
