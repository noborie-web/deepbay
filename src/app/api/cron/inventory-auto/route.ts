// Vercel Cron Job — Hobbyプラン向けに毎日0時UTC（9時台JST）に1回起動
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { endItem, reviseInventoryStatusBatch, addFixedPriceItem } from '@/lib/ebay-actions'
import { resolveInventoryAccessToken } from '@/lib/inventory-auth'
import { resolveDelistEligibility } from '@/lib/inventory-delist'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'
import { markListingsDelisted, syncKnownInventoryListings } from '@/lib/inventory-sync'
import { checkSupplierListings, normalizePriceChangeFilter } from '@/lib/inventory-supplier-check'

// 1回の実行で「①GetItem同期(148件〜)」「②仕入先チェック」「③取り下げ」
// 「④価格改定」を続けて行うため、Vercelのデフォルト上限では途中で
// 打ち切られる。auto-extraction と同じ300秒にする。
export const maxDuration = 300

// 価格改定(eBayへのRevise)に使う時間の上限。同期(約60秒)+仕入先チェック
// (最大120秒)+取り下げの後に残る時間の範囲に収める。
const REVISE_PRICE_TIME_BUDGET_MS = 75_000

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest) {
  // Vercel Cron認証
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = admin()

  // Vercel側で日次スケジュールを制御するため、ユーザー別の時刻照合は行わない
  const { data: allSettings } = await db
    .from('inventory_settings')
    .select('user_id, ebay_token, ebay_refresh_token, ebay_token_expires_at, ebay_auto_sync, auto_delist, auto_revise_price, auto_stack, days_until_delist, delist_by_age_enabled, delist_on_sold_out, price_change_direction, price_change_threshold_rate, payment_profile_name, return_profile_name, shipping_profile_name')
    .eq('sync_enabled', true)

  const results: Record<string, unknown>[] = []

  for (const settings of allSettings ?? []) {
    const hasEnabledAction = settings.ebay_auto_sync || settings.auto_delist || settings.auto_revise_price || settings.auto_stack
    const userId = settings.user_id
    const userResult: Record<string, unknown> = { user_id: userId }
    const runSupplierCheck = async () => {
      const startedAt = new Date().toISOString()
      try {
        // ユーザー要望: 「仕入先が売り切れたら即取り下げ」「仕入価格が
        // 上がっていればeBay価格を再計算」は必須。1日50件では148件を
        // 一巡するのに3日かかるため、時間予算(150秒)の範囲で最大500件まで
        // 未チェックが古い順に確認する。
        const supplierCheckResult = await checkSupplierListings(db, userId, 500, {
          timeBudgetMs: 120_000,
          priceChangeFilter: normalizePriceChangeFilter(settings),
        })
        userResult.supplier_check = supplierCheckResult
        // ユーザー要望: 「仕入れ価格の高騰に確実に対応」。この結果を
        // inventory_runsに記録しないと、cronのJSONレスポンス以外では
        // 誰も確認できず実質見えない状態になるため、他のアクション
        // (同期・取り下げ・価格改定・積み上げ)と同様に記録する。
        await db.from('inventory_runs').insert({
          user_id: userId,
          run_type: 'supplier_check',
          status: supplierCheckResult.failed > 0 ? 'failed' : 'completed',
          result_summary: supplierCheckResult,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        userResult.supplier_check = { error: errorMessage }
        await db.from('inventory_runs').insert({
          user_id: userId,
          run_type: 'supplier_check',
          status: 'failed',
          error_message: errorMessage,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
      }
    }

    if (!hasEnabledAction) {
      await runSupplierCheck()
      results.push(userResult)
      continue
    }

    let accessToken: string
    try {
      accessToken = await resolveInventoryAccessToken(db, userId, settings)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      userResult.auth = { error: errorMessage }
      const now = new Date().toISOString()
      await db.from('inventory_runs').insert({
        user_id: userId,
        run_type: 'sync',
        status: 'failed',
        error_message: `トークン取得失敗: ${errorMessage}`,
        started_at: now,
        finished_at: now,
      })
      await runSupplierCheck()
      results.push(userResult)
      continue
    }

    // eBay同期を先に実行し、失敗時は古い在庫情報で後続操作を行わない
    if (settings.ebay_auto_sync) {
      const startedAt = new Date().toISOString()
      try {
        // ユーザー要望: Kakehashiが出品したItemIDだけをGetItemで個別照会する。
        // 件数はKakehashiの出品数に比例するため、他ツールの出品数に左右されない。
        const syncResult = await syncKnownInventoryListings(db, userId, accessToken, { fetchTotalTimeoutMs: 180_000, discoveryTimeBudgetMs: 60_000 })
        userResult.sync = syncResult
        await db.from('inventory_runs').insert({
          user_id: userId,
          run_type: 'sync',
          status: 'completed',
          items_total: syncResult.total,
          items_matched: syncResult.matched,
          result_summary: { discovered: syncResult.discovered, ended: syncResult.ended, discovery_truncated: syncResult.discoveryTruncated },
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        userResult.sync = { error: errorMessage }
        await db.from('inventory_runs').insert({
          user_id: userId,
          run_type: 'sync',
          status: 'failed',
          error_message: errorMessage,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        })
        await runSupplierCheck()
        results.push(userResult)
        continue
      }
    }

    // eBay同期後に仕入れ元を確認し、売り切れ・削除をquantity=0へ反映する。
    // この直後の既存取り下げ処理が同じcron実行内で対象を検出する。
    await runSupplierCheck()

    // 取り下げ
    // ユーザー要望: 「売り切れ即取り下げ」ONなら在庫0だけを条件にし、
    // OFFなら「在庫0 かつ N日経過」(N日経過取り下げがOFFなら行わない)。
    const delistEligibility = resolveDelistEligibility(settings)
    if (settings.auto_delist && delistEligibility.enabled) {
      // ユーザー要望: 他ツールで在庫管理中の出品を誤って取り下げないよう、
      // Kakehashiの商品に紐付いている出品だけを対象にする。
      // 取り下げ済み(delisted_at あり)は毎日繰り返さない。
      let delistQuery = db
        .from('inventory_active_listings')
        .select('ebay_item_id, product_id')
        .eq('user_id', userId)
        .not('product_id', 'is', null)
        .eq('quantity', 0)
        .is('delisted_at', null)
      if (delistEligibility.cutoffIso) delistQuery = delistQuery.lte('start_time', delistEligibility.cutoffIso)
      const { data: listings } = await delistQuery

      const delistResults = []
      const quantityZeroEntries = []
      for (const l of listings ?? []) {
        if (l.product_id) quantityZeroEntries.push({ itemId: l.ebay_item_id as string, quantity: 0 })
        else delistResults.push(await endItem(accessToken, l.ebay_item_id))
      }
      // 4件ずつまとめて在庫0にする(件数が多くても時間内に終わるように)
      delistResults.push(...(await reviseInventoryStatusBatch(accessToken, quantityZeroEntries)).results)
      try {
        await markListingsDelisted(db, userId, delistResults.filter(r => r.success).map(r => r.itemId))
      } catch {
        // 記録の失敗で取り下げ結果自体は変わらないため続行する
      }
      userResult.delist = { total: delistResults.length, succeeded: delistResults.filter(r => r.success).length, immediate: delistEligibility.immediate }
      const delistRun = summarizeInventoryActionRun(delistResults)

      await db.from('inventory_runs').insert({
        user_id: userId, run_type: 'auto_delist', status: delistRun.status,
        error_message: delistRun.errorMessage,
        result_summary: userResult.delist,
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      })
    // ignore log errors
    }

    // 価格改定
    if (settings.auto_revise_price) {
      const { data: listings } = await db
        .from('inventory_active_listings')
        .select('ebay_item_id, current_price, product_id')
        .eq('user_id', userId)
        .not('product_id', 'is', null)

      const productIds = (listings ?? []).map(l => l.product_id as string)
      const productMap = new Map<string, { ebay_price: number | null }>()
      if (productIds.length > 0) {
        const { data: products } = await db.from('products').select('id, ebay_price').in('id', productIds)
        for (const p of products ?? []) productMap.set(p.id, p)
      }

      // 本番で確認した不具合: 価格改定が135件になった日に、Vercelの実行時間
      // 上限(300秒)に達して途中で打ち切られ、実行ログも残らなかった。
      // 時間予算内で処理し、残りは翌日に回す(ログは必ず残す)。
      // 4件ずつまとめて並行に送り、時間予算内で処理し切れない分だけ翌日に回す。
      const reviseStartedAt = Date.now()
      const reviseEntries = []
      for (const l of listings ?? []) {
        const p = productMap.get(l.product_id!)
        if (!p?.ebay_price || !l.current_price || Math.abs(p.ebay_price - l.current_price) <= 0.5) continue
        reviseEntries.push({ itemId: l.ebay_item_id as string, price: p.ebay_price })
      }
      const { results: reviseResults, deferred: reviseDeferred } = await reviseInventoryStatusBatch(
        accessToken, reviseEntries, { deadlineMs: reviseStartedAt + REVISE_PRICE_TIME_BUDGET_MS },
      )
      userResult.revise_price = { total: reviseResults.length, succeeded: reviseResults.filter(r => r.success).length, deferred: reviseDeferred }
      const reviseRun = summarizeInventoryActionRun(reviseResults)

      await db.from('inventory_runs').insert({
        user_id: userId, run_type: 'auto_revise_price', status: reviseRun.status,
        error_message: reviseRun.errorMessage,
        result_summary: userResult.revise_price,
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      })
    // ignore log errors
    }

    // 積み上げ
    if (settings.auto_stack && settings.payment_profile_name && settings.shipping_profile_name && settings.return_profile_name) {
      const { data: stackingItems } = await db
        .from('inventory_stacking')
        .select('ebay_item_id, new_source_url')
        .eq('user_id', userId)
        .eq('is_excluded', false)
        .not('new_source_url', 'is', null)

      const ebayItemIds = (stackingItems ?? []).map(s => s.ebay_item_id)
      const { data: listings } = await db
        .from('inventory_active_listings')
        .select('ebay_item_id, title, current_price, product_id')
        .eq('user_id', userId)
        .in('ebay_item_id', ebayItemIds)
        .eq('quantity', 0)

      const listingMap = new Map((listings ?? []).map(l => [l.ebay_item_id, l]))
      const productIds = (listings ?? []).filter(l => l.product_id).map(l => l.product_id as string)
      const productMap = new Map<string, { ebay_category_id: string | null; ebay_title: string | null; ebay_price: number | null; description: string | null }>()
      if (productIds.length > 0) {
        const { data: products } = await db.from('products').select('id, ebay_category_id, ebay_title, ebay_price, description').in('id', productIds)
        for (const p of products ?? []) productMap.set(p.id, p)
      }

      const stackResults = []
      for (const s of stackingItems ?? []) {
        const listing = listingMap.get(s.ebay_item_id)
        if (!listing) continue
        const product = listing.product_id ? productMap.get(listing.product_id) : null
        const r = await addFixedPriceItem(accessToken, {
          title: product?.ebay_title ?? listing.title ?? '',
          price: product?.ebay_price ?? listing.current_price ?? 0,
          categoryId: product?.ebay_category_id ?? '1',
          description: product?.description ?? '',
          pictureUrls: [],
          sku: `stack_${s.ebay_item_id}_${Date.now()}`,
          paymentProfileName: settings.payment_profile_name,
          returnProfileName: settings.return_profile_name,
          shippingProfileName: settings.shipping_profile_name,
        })
        stackResults.push(r)
        if (r.success) {
          await db.from('inventory_stacking')
            .update({ new_source_url: null, note: `stacked:${r.itemId}`, updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('ebay_item_id', s.ebay_item_id)
        }
      }
      userResult.stack = { total: stackResults.length, succeeded: stackResults.filter(r => r.success).length }
      const stackRun = summarizeInventoryActionRun(stackResults)

      await db.from('inventory_runs').insert({
        user_id: userId, run_type: 'auto_stack', status: stackRun.status,
        error_message: stackRun.errorMessage,
        result_summary: userResult.stack,
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      })
    // ignore log errors
    }

    results.push(userResult)
  }

  return NextResponse.json({ ok: true, processed: results.length, results })
}
