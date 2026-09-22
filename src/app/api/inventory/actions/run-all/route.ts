import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ユーザー要望: 全体在庫管理(同期 → 仕入先チェック → 取り下げ → 価格改定)を
// 手動で今すぐ実行する。日次cronと同じ処理を、ログイン中のユーザーだけを対象に
// 呼び出す(稼働回数の時間帯・二重起動の判定は行わない)。
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'CRON_SECRET が設定されていません' }, { status: 500 })

  // 自分自身(このリクエストと同じオリジン)の cron エンドポイントを呼ぶ
  const base = new URL(req.url).origin
  const url = `${base}/api/cron/inventory-auto?user_id=${encodeURIComponent(user.id)}&force=1&slot=9`
  const startedAt = Date.now()
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return NextResponse.json({ error: json.error ?? `実行に失敗しました (${res.status})` }, { status: 500 })
    const result = Array.isArray(json.results) ? json.results[0] ?? null : null
    return NextResponse.json({ ok: true, elapsed_ms: Date.now() - startedAt, result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
