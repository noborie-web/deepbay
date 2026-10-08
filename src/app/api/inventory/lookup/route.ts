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
  // CustomLabelは "kakehashi_<商品UUID(-を_に置換)>" 形式(ツール名変更前に
  // 出品された商品は "deepbay_..." 形式のまま)で、商品IDそのものを直接
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

  // ユーザー報告(2026-10-08): 売れた商品のDBK-IDが「見つかりませんでした」に
  // なった。出品終了時に対応表を消していたため、売却後は記録が残らなかった。
  // 終了した出品の履歴(inventory_ended_listings)からも辿れるようにする。
  // eBayの商品番号(数字のみ)を貼り付けた場合にも対応する。
  const endedQuery = db
    .from('inventory_ended_listings')
    .select('product_id, source_url, title, custom_label, ebay_item_id, ended_reason, ended_at')
    .eq('user_id', user.id)
    .limit(1)
  const { data: endedRows } = /^\d{9,15}$/.test(code)
    ? await endedQuery.eq('ebay_item_id', code)
    : await endedQuery.eq('custom_label', code)
  const ended = endedRows?.[0]
  if (ended) {
    // 商品が残っていれば最新の仕入先URLを優先し、消えていれば終了時の控えを使う
    let sourceUrl = ended.source_url as string | null
    let title = ended.title as string | null
    if (ended.product_id) {
      const { data: product } = await db
        .from('products')
        .select('source_url, original_title')
        .eq('user_id', user.id)
        .eq('id', ended.product_id)
        .maybeSingle()
      if (product) {
        sourceUrl = (product.source_url as string | null) ?? sourceUrl
        title = (product.original_title as string | null) ?? title
      }
    }
    if (sourceUrl) {
      return NextResponse.json({
        found: true,
        source_url: sourceUrl,
        title,
        product_id: ended.product_id,
        ended_reason: ended.ended_reason,
        ended_at: ended.ended_at,
        ebay_item_id: ended.ebay_item_id,
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
  if (!data) {
    // ユーザー報告(2026-10-08): 「見つかりませんでした」だけでは、DBK-IDの
    // 形式が違うのか、商品が削除済みなのかが区別できない。
    return NextResponse.json({
      found: false,
      source_url: null,
      reason: directProductId ? 'product_missing' : 'unrecognized_code',
    })
  }

  return NextResponse.json({
    found: true,
    source_url: data.source_url,
    title: data.original_title,
    product_id: data.id,
  })
}
