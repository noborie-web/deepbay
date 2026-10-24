import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { flushEbayCallCounts } from '@/lib/ebay-call-counter'
import { REVISE_PRICE_TIME_BUDGET_MS, runRevisePriceForUser } from '@/lib/inventory-revise-price'

// 価格改定だけを行うcron。
//
// 本番で確認した不具合(2026-10-23): 日次cron(inventory-auto)の中では、
// 同期・仕入先チェック・取り下げで236〜275秒(実測4回)を使い切り、
// 300秒の上限に当たって価格改定が記録を書く前に強制終了していた。
// 「価格改定を自動実行する」をONにしても auto_revise_price の記録が
// 1件も残らず、設定を見ても原因が分からない形だった。
//
// 工程の順番を入れ替えても時間の押し付け合いになるだけなので、
// 価格改定は独立させて300秒をまるごと使えるようにする。
export const maxDuration = 300

// 1ユーザーあたりの送信時間。残りは次回に持ち越す。
// 進行中のバッチが終わるまで余裕を見て、maxDuration を超えないようにする。
const USER_TIME_BUDGET_MS = REVISE_PRICE_TIME_BUDGET_MS

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = admin()
  const onlyUserId = req.nextUrl.searchParams.get('user_id')

  let query = db
    .from('inventory_settings')
    .select('user_id, ebay_token, ebay_refresh_token, ebay_token_expires_at, auto_revise_price')
    .eq('sync_enabled', true)
    .eq('auto_revise_price', true)
  if (onlyUserId) query = query.eq('user_id', onlyUserId)

  // 失敗を黙って「対象0人」にしない。0件になると価格改定がまるごと
  // 行われないまま正常終了してしまう(今回と同じ形の見逃しになる)。
  const { data: allSettings, error: settingsError } = await query
  if (settingsError) {
    return NextResponse.json({ error: `設定を取得できませんでした: ${settingsError.message}` }, { status: 500 })
  }

  const results: Record<string, unknown>[] = []
  for (const settings of allSettings ?? []) {
    const userId = settings.user_id as string
    const startedAt = new Date().toISOString()
    // 本番で確認した不具合(2026-10-24): cronは4回発火したのに記録は1回しか
    // 残らなかった。300秒の上限で関数ごと強制終了されると、最後に書く形では
    // 記録自体が残らない。先に running で作っておき、終わったら更新する。
    // こうすれば「落ちた」ことが running のまま残って分かる。
    const { data: runRow, error: runInsertError } = await db.from('inventory_runs').insert({
      user_id: userId,
      run_type: 'auto_revise_price',
      status: 'running',
      started_at: startedAt,
    }).select('id').maybeSingle()
    // 記録を作れなかったら、その旨をログに残す(黙って記録なしにしない)
    if (runInsertError) console.warn('[revise-price] 実行記録を作れませんでした:', runInsertError.message)
    const runId = runRow?.id as string | undefined
    const finish = async (row: Record<string, unknown>) => {
      if (runId) await db.from('inventory_runs').update(row).eq('id', runId)
      else await db.from('inventory_runs').insert({ user_id: userId, run_type: 'auto_revise_price', started_at: startedAt, ...row })
    }
    try {
      const { summary, status, errorMessage } = await runRevisePriceForUser(db, userId, settings, {
        timeBudgetMs: USER_TIME_BUDGET_MS,
      })
      await flushEbayCallCounts(db, userId)
      await finish({
        status,
        error_message: errorMessage,
        result_summary: summary,
        finished_at: new Date().toISOString(),
      })
      results.push({ user_id: userId, ...summary, items: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 失敗も必ず残す。記録が無いと「動いていない」ことに気づけない
      await finish({ status: 'failed', error_message: message, finished_at: new Date().toISOString() })
      results.push({ user_id: userId, error: message })
    }
  }

  return NextResponse.json({ ok: true, users: results.length, results })
}
