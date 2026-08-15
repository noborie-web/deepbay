// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { resolveInventoryAccessToken } from '@/lib/inventory-auth'
import { expireStaleInventorySyncRuns } from '@/lib/inventory-run'
import { syncInventoryListingBatch } from '@/lib/inventory-sync'
import { createInventorySyncCursor, parseInventorySyncCursor } from '@/lib/inventory-sync-cursor'

const ROUTE_TIMEOUT_MS = 40_000
const PAGES_PER_REQUEST = 4

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const cursorSecret = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const body = await request.json().catch(() => ({})) as { cursor?: unknown }
  const cursorValue = typeof body.cursor === 'string' ? body.cursor : null

  const { data: settings, error: settingsError } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })

  let runId: string
  let startPage = 1
  let previousTotal = 0
  let previousMatched = 0

  if (cursorValue) {
    let cursor
    try {
      cursor = parseInventorySyncCursor(cursorValue, cursorSecret)
    } catch {
      return NextResponse.json({ error: '同期の継続情報が無効です。最初からやり直してください。' }, { status: 400 })
    }

    const { data: existingRun, error: existingRunError } = await db
      .from('inventory_runs')
      .select('id, status, items_total, items_matched')
      .eq('id', cursor.runId)
      .eq('user_id', user.id)
      .eq('run_type', 'sync')
      .maybeSingle()

    if (existingRunError) return NextResponse.json({ error: existingRunError.message }, { status: 500 })
    if (!existingRun || existingRun.status !== 'running') {
      return NextResponse.json({ error: '継続対象の同期処理が見つかりません。最初からやり直してください。' }, { status: 409 })
    }

    runId = existingRun.id
    startPage = cursor.nextPage
    previousTotal = existingRun.items_total ?? 0
    previousMatched = existingRun.items_matched ?? 0
  } else {
    try {
      await expireStaleInventorySyncRuns(db, user.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return NextResponse.json({ error: msg }, { status: 500 })
    }

    const { data: run, error: runError } = await db
      .from('inventory_runs')
      .insert({
        user_id: user.id,
        run_type: 'sync',
        status: 'running',
        items_total: 0,
        items_matched: 0,
      })
      .select('id')
      .single()

    if (runError || !run) return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
    runId = run.id
  }

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

  if (!cursorValue) {
    // eBay active results are a complete snapshot. Clear the previous
    // snapshot once at the start of a new resumable sync, after auth/token
    // validation succeeds.
    const { error: clearError } = await db
      .from('inventory_active_listings')
      .delete()
      .eq('user_id', user.id)
    if (clearError) return NextResponse.json({ error: `既存の在庫スナップショットを更新できません: ${clearError.message}` }, { status: 500 })
  }

  let syncResult: Awaited<ReturnType<typeof syncInventoryListingBatch>>
  const syncController = new AbortController()
  const routeTimeout = setTimeout(() => {
    syncController.abort(new Error(`在庫同期が${ROUTE_TIMEOUT_MS / 1000}秒を超えたため終了しました`))
  }, ROUTE_TIMEOUT_MS)
  try {
    syncResult = await Promise.race([
      syncInventoryListingBatch(
        db,
        user.id,
        accessToken,
        startPage,
        PAGES_PER_REQUEST,
        { signal: syncController.signal },
      ),
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

  const fetchedTotal = previousTotal + syncResult.total
  const matched = previousMatched + syncResult.matched
  const done = syncResult.nextPage === null
  let total = fetchedTotal

  if (done) {
    const { count: storedTotal, error: countError } = await db
      .from('inventory_active_listings')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)

    // The eBay result pages can overlap while listings are changing. The
    // stored table is unique by user and eBay item ID, so use its exact count
    // for the completed run instead of the inflated sum of fetched pages.
    if (!countError && storedTotal !== null) total = storedTotal
  }

  const { error: updateError } = await db.from('inventory_runs').update({
    status: done ? 'completed' : 'running',
    items_total: total,
    items_matched: matched,
    finished_at: done ? new Date().toISOString() : null,
  }).eq('id', runId)

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    total,
    matched,
    done,
    cursor: done ? null : createInventorySyncCursor(runId, syncResult.nextPage!, cursorSecret),
    progress: {
      page: syncResult.lastFetchedPage,
      totalPages: syncResult.totalPages,
    },
  })
}
