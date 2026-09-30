import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { pacificDate } from '@/lib/ebay-call-counter'

// ユーザー要望(2026-09-30): APIの容量と消費が見えるようにしたい。
// eBayの GetApiAccessRules は廃止(HTTP 410)されて使えないため、Kakehashiが
// 送った回数を自分で数えて表示する。枠は太平洋時間の日付で切り替わる。
function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// eBayの既定の上限(呼び出しごと/1日)。実際の上限はアプリの審査状況で変わるため、
// 目安として扱う(環境変数で変更できる)。
const DEFAULT_DAILY_LIMIT = Number(process.env.EBAY_DAILY_CALL_LIMIT ?? 5000)

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const today = pacificDate()
  const { data, error } = await db
    .from('ebay_api_calls')
    .select('call_name, count, called_on')
    .eq('user_id', user.id)
    .gte('called_on', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const todayByCall = new Map<string, number>()
  const byDay = new Map<string, number>()
  for (const row of data ?? []) {
    const day = row.called_on as string
    const count = Number(row.count) || 0
    byDay.set(day, (byDay.get(day) ?? 0) + count)
    if (day === today) {
      const name = row.call_name as string
      todayByCall.set(name, (todayByCall.get(name) ?? 0) + count)
    }
  }

  const calls = Array.from(todayByCall.entries())
    .map(([callName, count]) => ({ callName, count }))
    .sort((a, b) => b.count - a.count)

  return NextResponse.json({
    today,
    daily_limit: DEFAULT_DAILY_LIMIT,
    total: calls.reduce((sum, c) => sum + c.count, 0),
    calls,
    // 直近7日の推移(多い日がどれくらいかの目安)
    history: Array.from(byDay.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, 7),
  })
}
