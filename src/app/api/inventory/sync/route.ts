// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { resolveInventoryAccessToken } from '@/lib/inventory-auth'
import { expireStaleInventorySyncRuns } from '@/lib/inventory-run'
import { syncInventoryListings } from '@/lib/inventory-sync'

const ROUTE_TIMEOUT_MS = 40_000

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()

  const { data: settings, error: settingsError } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })

  try {
    await expireStaleInventorySyncRuns(db, user.id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const { data: run, error: runError } = await db
    .from('inventory_runs')
    .insert({ user_id: user.id, run_type: 'sync', status: 'running' })
    .select('id')
    .single()

  if (runError || !run) return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
  const runId = run.id

  let accessToken: string
  try {
    accessToken = await resolveInventoryAccessToken(db, user.id, settings ?? {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.from('inventory_runs').update({
      status: 'failed', error_message: msg, finished_at: new Date().toISOString(),
    }).eq('id', runId)
    return NextResponse.json({ error: `トークン更新失敗: ${msg}` }, { status: 500 })
  }

  let syncResult
  const syncController = new AbortController()
  const routeTimeout = setTimeout(() => {
    syncController.abort(new Error(`在庫同期が${ROUTE_TIMEOUT_MS / 1000}秒を超えたため終了しました`))
  }, ROUTE_TIMEOUT_MS)
  try {
    syncResult = await Promise.race([
      syncInventoryListings(db, user.id, accessToken, { signal: syncController.signal }),
      new Promise<never>((_, reject) => {
        syncController.signal.addEventListener('abort', () => {
          reject(syncController.signal.reason)
        }, { once: true })
      }),
    ])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.from('inventory_runs').update({
      status: 'failed', error_message: msg, finished_at: new Date().toISOString(),
    }).eq('id', runId)
    return NextResponse.json({ error: `eBay取得失敗: ${msg}` }, { status: 500 })
  } finally {
    clearTimeout(routeTimeout)
  }

  await db.from('inventory_runs').update({
    status: 'completed',
    items_total: syncResult.total,
    items_matched: syncResult.matched,
    finished_at: new Date().toISOString(),
  }).eq('id', runId)

  return NextResponse.json({ ok: true, total: syncResult.total, matched: syncResult.matched })
}
