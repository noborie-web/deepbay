import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { fetchApiAccessRules } from '@/lib/ebay-api-usage'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'

// ユーザー要望(2026-09-30): APIの容量と消費が見えるようにしたい。
// 呼び出し枠はeBayのアプリ単位なので、接続済みのどのセラーのトークンでも
// 同じ値が返る。代表のトークンで1回だけ問い合わせる。
function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const { data: settings } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  try {
    const resolver = await createInventoryTokenResolver(db, user.id, settings ?? {})
    if (!resolver.defaultToken) {
      return NextResponse.json({ error: 'eBayアカウントが接続されていません' }, { status: 400 })
    }
    const rules = await fetchApiAccessRules(resolver.defaultToken)
    // 在庫管理で使う呼び出しを先に、使用量の多い順で返す
    const sorted = [...rules].sort((a, b) => {
      if (a.used !== b.used) return a.used ? -1 : 1
      return b.dailyUsage - a.dailyUsage
    })
    return NextResponse.json({ rules: sorted, fetched_at: new Date().toISOString() })
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'eBayの利用状況を取得できませんでした',
    }, { status: 502 })
  }
}
