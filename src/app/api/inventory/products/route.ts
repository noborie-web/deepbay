import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const STATUSES = new Set(['draft', 'listing', 'listed', 'sold', 'delisted'])
const LIMIT = 500

// 実データで確認した不具合: 在庫管理画面の商品テーブルは直近100件だけを
// 読み込んでいたため、集計カード(下書き4件)をクリックしても、100件より
// 古い下書きは一覧に出ず「下書きの商品はありません」と表示されていた。
// カードの状態ごとに商品をサーバーから取得する。
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const status = request.nextUrl.searchParams.get('status')
  let query = supabase
    .from('products')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  if (status && STATUSES.has(status)) query = query.eq('listing_status', status)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ products: data ?? [] })
}
