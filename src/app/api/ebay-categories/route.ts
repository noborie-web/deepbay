import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

// 本番で確認した不具合(2026-09-23): eBayは末端(leaf)カテゴリにしか出品できず、
// 親カテゴリ(例: 222 Diecast & Toy Vehicles)を指定したCSVは
// 「The category selected is not a leaf category.」で全件エラーになる。
// 検索結果に leaf かどうかを付けて返し、親カテゴリは登録させない。
// mode=children を指定すると、そのカテゴリの子(leaf判定付き)を返す。
function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface CategoryRow { id: string; name: string; level: number | null }

async function withLeafFlag(db: ReturnType<typeof admin>, rows: CategoryRow[]) {
  if (rows.length === 0) return []
  const ids = rows.map(r => r.id)
  const { data: children } = await db
    .from('ebay_categories')
    .select('parent_id')
    .in('parent_id', ids)
  const parents = new Set((children ?? []).map(c => String(c.parent_id)))
  return rows.map(r => ({ ...r, is_leaf: !parents.has(r.id) }))
}

export async function GET(req: NextRequest) {
  const db = admin()
  const mode = req.nextUrl.searchParams.get('mode')

  if (mode === 'children') {
    const parentId = req.nextUrl.searchParams.get('parent')?.trim()
    if (!parentId) return NextResponse.json({ error: 'parent が必要です' }, { status: 400 })
    const { data, error } = await db
      .from('ebay_categories')
      .select('id, name, level')
      .eq('parent_id', parentId)
      .order('name', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(await withLeafFlag(db, (data ?? []) as CategoryRow[]))
  }

  const q = req.nextUrl.searchParams.get('q')?.trim()
  if (!q) return NextResponse.json([])

  // カテゴリIDそのものでの検索にも対応する
  const byId = /^\d+$/.test(q)
  const query = byId
    ? db.from('ebay_categories').select('id, name, level').or(`id.eq.${q},name.ilike.%${q}%`)
    : db.from('ebay_categories').select('id, name, level').ilike('name', `%${q}%`)
  const { data, error } = await query.order('level', { ascending: true }).limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(await withLeafFlag(db, (data ?? []) as CategoryRow[]))
}
