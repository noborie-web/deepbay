// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'
import { EbayCallLimitError } from '@/lib/ebay-inventory'
import { expireStaleInventorySyncRuns } from '@/lib/inventory-run'
import { syncKnownInventoryListingBatch } from '@/lib/inventory-sync'
import { createInventorySyncCursor, parseInventorySyncCursor } from '@/lib/inventory-sync-cursor'

// 実データで確認した不具合: maxDuration未設定のためVercelのデフォルト上限で
// 関数が途中終了し、同期が「実行中」のまま止まって149件が取り込まれなかった。
// Hobbyプランの上限(60秒)を明示し、内部のタイムアウト(40秒)がそれより
// 先に発火して正常にエラーを返せるようにする。
export const maxDuration = 60

const ROUTE_TIMEOUT_MS = 40_000
// ユーザー要望: Kakehashiが出品したItemIDだけをGetItemで個別照会する。
// 1リクエストで照会する件数(同時4件で1件あたり約1秒 → 15秒前後)。
const ITEMS_PER_REQUEST = 60

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
  let startBatch = 1
  let previousMatched = 0
  // 出品アカウントを複数運用している場合、セラーを順番に同期する
  let sellerIndex = 0

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
    startBatch = cursor.nextPage
    sellerIndex = cursor.sellerIndex ?? 0
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
  let syncTargets: Array<{ id: string; seller_id: string; listing_site_ids?: string[] } | null>
  try {
    const tokenResolver = await createInventoryTokenResolver(db, user.id, settings ?? {})
    syncTargets = tokenResolver.accounts.length > 0 ? tokenResolver.accounts : [null]
    const target = syncTargets[Math.min(sellerIndex, syncTargets.length - 1)]
    const token = target ? tokenResolver.tokenFor(target.id) : tokenResolver.defaultToken
    if (!token) throw new Error('eBayアカウントが接続されていません')
    accessToken = token
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.from('inventory_runs').update({
      status: 'failed', error_message: msg, finished_at: new Date().toISOString(),
    }).eq('id', runId)
    return NextResponse.json({ error: `トークン更新失敗: ${msg}` }, { status: 500 })
  }

  // 個別照会方式では在庫一覧のItemIDが照会対象そのものなので、同期開始時に
  // 一覧を消してはいけない(従来の全件走査方式のスナップショット全削除は撤廃)。
  // 終了済みの出品は照会結果に基づいて個別に除外する。
  let syncResult: Awaited<ReturnType<typeof syncKnownInventoryListingBatch>>
  const syncController = new AbortController()
  const routeTimeout = setTimeout(() => {
    syncController.abort(new Error(`在庫同期が${ROUTE_TIMEOUT_MS / 1000}秒を超えたため終了しました`))
  }, ROUTE_TIMEOUT_MS)
  try {
    syncResult = await Promise.race([
      syncKnownInventoryListingBatch(
        db,
        user.id,
        accessToken,
        startBatch,
        ITEMS_PER_REQUEST,
        {
          signal: syncController.signal,
          discoveryTimeBudgetMs: 15_000,
          sellerAccountId: syncTargets[Math.min(sellerIndex, syncTargets.length - 1)]?.id ?? null,
          sellerSiteIds: syncTargets[Math.min(sellerIndex, syncTargets.length - 1)]?.listing_site_ids ?? null,
          // eBayの呼び出し上限を使い切らないよう、直近30分に取得済みの出品は
          // 再照会しない(新規出品の発見は毎回行う)
          skipFetchedWithinMs: 30 * 60 * 1000,
          ownsUnassignedProducts: sellerIndex === 0,
        },
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
    // 呼び出し上限は時間をおけば回復するため、失敗理由をそのまま伝える
    if (e instanceof EbayCallLimitError) {
      return NextResponse.json({ error: msg }, { status: 429 })
    }
    return NextResponse.json({ error: `eBay取得失敗: ${msg}` }, { status: 500 })
  } finally {
    clearTimeout(routeTimeout)
  }

  const matched = previousMatched + syncResult.updated + syncResult.discovered
  // このセラーを処理し終えたら次のセラーの1バッチ目へ進む
  const hasNextBatch = syncResult.nextBatch !== null
  const nextSellerIndex = hasNextBatch ? sellerIndex : sellerIndex + 1
  const done = !hasNextBatch && nextSellerIndex >= syncTargets.length
  let total = syncResult.totalItems

  if (done) {
    const { count: storedTotal, error: countError } = await db
      .from('inventory_active_listings')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    // 完了時は在庫一覧の実件数(終了済みを除外した後)を総数として記録する
    if (!countError && storedTotal !== null) total = storedTotal
  }

  const { error: updateError } = await db.from('inventory_runs').update({
    status: done ? 'completed' : 'running',
    items_total: total,
    items_matched: matched,
    // 新規出品の発見に失敗した理由を履歴にも残す(画面からもDBからも追える)
    ...(syncResult.discoveryError
      ? { result_summary: { discovery_error: syncResult.discoveryError, seller_index: sellerIndex } }
      : {}),
    finished_at: done ? new Date().toISOString() : null,
  }).eq('id', runId)

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    total,
    matched,
    ended: syncResult.ended,
    discovered: syncResult.discovered,
    discovery_truncated: syncResult.discoveryTruncated,
    // 新規出品の発見に失敗した理由(UK/AUが取り込まれない等の原因を画面に出す)
    discovery_error: syncResult.discoveryError ?? null,
    done,
    cursor: done
      ? null
      : createInventorySyncCursor(runId, hasNextBatch ? syncResult.nextBatch! : 1, cursorSecret, nextSellerIndex),
    progress: {
      processed: syncResult.processedItems,
      total: syncResult.totalItems,
    },
  })
}
