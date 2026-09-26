// Vercel Cron Job — Hobbyプラン向けに毎日0時UTC（9時台JST）に1回起動
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { endItem, reviseInventoryStatusBatch, addFixedPriceItem } from '@/lib/ebay-actions'
import { resolveInventoryAccessToken, resolveSellerAccountAccessToken } from '@/lib/inventory-auth'
import { listInventorySellerAccounts, sellerAccountLabel, type InventorySellerAccount } from '@/lib/inventory-seller-accounts'
import { resolveDelistEligibility } from '@/lib/inventory-delist'
import { isSlotActive, normalizeDailyRunCount, normalizeRevisePriceSchedule, resolveRunSlot, shouldRevisePriceInSlot } from '@/lib/inventory-schedule'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'
import { decideSiteRevisePrice, loadJpyRates } from '@/lib/inventory-site-pricing'
import { currencyForSite } from '@/lib/ebay-sites'
import { applyRevisedPrices, markListingsDelisted, syncKnownInventoryListings } from '@/lib/inventory-sync'
import { checkSupplierListings, normalizePriceChangeFilter } from '@/lib/inventory-supplier-check'

// 1回の実行で「①GetItem同期(148件〜)」「②仕入先チェック」「③取り下げ」
// 「④価格改定」を続けて行うため、Vercelのデフォルト上限では途中で
// 打ち切られる。auto-extraction と同じ300秒にする。
export const maxDuration = 300

// 価格改定(eBayへのRevise)に使う時間の上限。同期(約60秒)+仕入先チェック
// (最大120秒)+取り下げの後に残る時間の範囲に収める。
const REVISE_PRICE_TIME_BUDGET_MS = 60_000

// セラーごとにまとめる(トークンがセラー単位のため、1リクエストに混ぜられない)
function groupEntriesBySeller<T extends { sellerAccountId?: string | null }>(
  entries: T[],
): Array<[string | null, T[]]> {
  const groups = new Map<string | null, T[]>()
  for (const entry of entries) {
    const key = entry.sellerAccountId ?? null
    const list = groups.get(key) ?? []
    list.push(entry)
    groups.set(key, list)
  }
  return Array.from(groups.entries())
}

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

  // ユーザー要望: 1日最大4回(03/09/15/21 JST)。pg_cron からは ?slot=JST時 で呼ばれ、
  // Vercel cron(朝のみ・時刻不定)からは現在時刻から時間帯を求める。
  const slot = resolveRunSlot(req.nextUrl.searchParams.get('slot'))
  // ユーザー要望: 「全体在庫管理を今すぐ実行」(手動)。対象ユーザーを絞り、
  // 稼働回数の時間帯や二重起動の判定は行わない(force=1)。
  const onlyUserId = req.nextUrl.searchParams.get('user_id')
  const force = req.nextUrl.searchParams.get('force') === '1'

  let settingsQuery = db
    .from('inventory_settings')
    .select('user_id, ebay_token, ebay_refresh_token, ebay_token_expires_at, ebay_auto_sync, auto_delist, auto_revise_price, auto_stack, days_until_delist, delist_by_age_enabled, delist_on_sold_out, price_change_direction, price_change_threshold_rate, delist_on_title_change, sync_cursor_item_id, payment_profile_name, return_profile_name, shipping_profile_name, daily_run_count, revise_price_schedule')
    .eq('sync_enabled', true)
  if (onlyUserId) settingsQuery = settingsQuery.eq('user_id', onlyUserId)
  const { data: allSettings } = await settingsQuery

  const results: Record<string, unknown>[] = []

  for (const settings of allSettings ?? []) {
    const hasEnabledAction = settings.ebay_auto_sync || settings.auto_delist || settings.auto_revise_price || settings.auto_stack
    const userId = settings.user_id
    const userResult: Record<string, unknown> = { user_id: userId, slot }

    // この時間帯が稼働回数の対象でなければスキップ
    if (!force && !isSlotActive(normalizeDailyRunCount(settings.daily_run_count), slot)) {
      userResult.skipped = 'slot_inactive'
      results.push(userResult)
      continue
    }
    // 同じ時間帯に二重起動しない(Vercel cron と pg_cron の朝の重なり等)
    const { data: recentRun } = await db
      .from('inventory_runs')
      .select('id')
      .eq('user_id', userId)
      .eq('run_type', 'sync')
      .gte('started_at', new Date(Date.now() - 90 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle()
    if (recentRun && !force) {
      userResult.skipped = 'recently_ran'
      results.push(userResult)
      continue
    }
    // 価格改定を「朝のみ」にしている場合、朝以外の時間帯ではeBayへの反映を行わない
    const revisePriceThisSlot = force || shouldRevisePriceInSlot(normalizeRevisePriceSchedule(settings.revise_price_schedule), slot)
    const runSupplierCheck = async () => {
      const startedAt = new Date().toISOString()
      try {
        // ユーザー要望: 「仕入先が売り切れたら即取り下げ」「仕入価格が
        // 上がっていればeBay価格を再計算」は必須。1日50件では148件を
        // 一巡するのに3日かかるため、時間予算(150秒)の範囲で最大500件まで
        // 未チェックが古い順に確認する。
        const supplierCheckResult = await checkSupplierListings(db, userId, 500, {
          timeBudgetMs: 80_000,
          priceChangeFilter: normalizePriceChangeFilter(settings),
          delistOnTitleChange: settings.delist_on_title_change ?? true,
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

    // ユーザー要望(2026-09-25): 出品アカウントを複数運用し、それぞれ独立して
    // 在庫管理する。「混在しないよう細心の注意が必要」とのことなので、同期も
    // 取り下げも価格改定も、必ずセラーごとにトークンを分けて実行する。
    let accounts: InventorySellerAccount[] = []
    const tokens = new Map<string, string>()
    const authErrors: Array<{ seller: string; error: string }> = []
    let accessToken: string
    try {
      accounts = await listInventorySellerAccounts(db, userId)
      for (const account of accounts) {
        try {
          tokens.set(account.id, await resolveSellerAccountAccessToken(db, userId, account.id))
        } catch (error) {
          authErrors.push({ seller: sellerAccountLabel(account), error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (authErrors.length > 0) userResult.auth_errors = authErrors
      // 出品アカウントが1件も接続されていない場合だけ、従来の単一トークンで動かす
      accessToken = tokens.size > 0
        ? tokens.values().next().value as string
        : await resolveInventoryAccessToken(db, userId, settings)
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
    // 在庫管理の対象セラー(接続済み)。1件もなければ従来どおり単一セラー扱い。
    const syncTargets: Array<InventorySellerAccount | null> = accounts.filter(a => tokens.has(a.id))
    if (syncTargets.length === 0) syncTargets.push(null)
    const tokenFor = (account: InventorySellerAccount | null): string =>
      account ? (tokens.get(account.id) as string) : accessToken
    // 出品行のセラーに対応するトークン。セラーが分からない行は、対象セラーが
    // 1件のときだけそのトークンで扱い、複数運用しているときは触らない。
    const resolveListingToken = (sellerAccountId: string | null): string | null => {
      if (sellerAccountId) return tokens.get(sellerAccountId) ?? null
      return syncTargets.length === 1 ? tokenFor(syncTargets[0]) : null
    }

    if (settings.ebay_auto_sync) {
      const startedAt = new Date().toISOString()
      // 実行時間(300秒)は全セラーで分け合う。1セラーのときは従来と同じ予算。
      const share = syncTargets.length
      const syncResults: Record<string, unknown>[] = []
      try {
        // ユーザー要望: Kakehashiが出品したItemIDだけをGetItemで個別照会する。
        // 件数はKakehashiの出品数に比例するため、他ツールの出品数に左右されない。
        // 本番で確認した不具合(2026-09-22): 453件規模で 同期140秒 + 仕入先チェック120秒 +
        // 取り下げ で300秒に達し、価格改定が実行されなかった。同期はGetItemの並行数を
        // 上げて短縮し、各工程の時間予算を合計で300秒に収める。
        // 出品が1,000件を超えても300秒に収まるよう、1回あたりの照会件数を
        // 上限付きにして、続きは次の実行(3/9/15/21時)から再開する。
        for (const [index, account] of syncTargets.entries()) {
          const syncResult = await syncKnownInventoryListings(db, userId, tokenFor(account), {
            fetchTotalTimeoutMs: Math.floor(110_000 / share),
            discoveryTimeBudgetMs: Math.floor(30_000 / share),
            getItemConcurrency: 8,
            maxItemsPerRun: Math.floor(800 / share),
            cursorItemId: account ? account.inventory_sync_cursor_item_id : (settings.sync_cursor_item_id ?? null),
            sellerAccountId: account?.id ?? null,
            // 出品セラー未設定の古い抽出は、最初に接続したセラーのものとして扱う
            ownsUnassignedProducts: index === 0,
          })
          if (account) {
            await db.from('seller_accounts').update({ inventory_sync_cursor_item_id: syncResult.nextCursorItemId }).eq('id', account.id)
          } else {
            await db.from('inventory_settings').update({ sync_cursor_item_id: syncResult.nextCursorItemId }).eq('user_id', userId)
          }
          const summary = {
            seller_id: account?.seller_id ?? null,
            discovered: syncResult.discovered, ended: syncResult.ended, discovery_truncated: syncResult.discoveryTruncated,
            processed: syncResult.processed, remaining: syncResult.nextCursorItemId ? syncResult.total - syncResult.processed : 0,
          }
          syncResults.push({ ...summary, total: syncResult.total, matched: syncResult.matched })
          await db.from('inventory_runs').insert({
            user_id: userId,
            run_type: 'sync',
            status: 'completed',
            items_total: syncResult.total,
            items_matched: syncResult.matched,
            result_summary: summary,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
          })
        }
        userResult.sync = syncResults.length === 1 ? syncResults[0] : { sellers: syncResults }
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
        .select('ebay_item_id, product_id, seller_account_id, site_id')
        .eq('user_id', userId)
        .not('product_id', 'is', null)
        .eq('quantity', 0)
        .is('delisted_at', null)
      if (delistEligibility.cutoffIso) delistQuery = delistQuery.lte('start_time', delistEligibility.cutoffIso)
      const { data: listings } = await delistQuery

      const delistResults = []
      const quantityZeroEntries: Array<{ itemId: string; quantity: number; siteId: string | null; sellerAccountId: string | null }> = []
      // 出品したセラーのトークンで、そのサイトのSiteIDで呼ぶ。どのセラーの
      // 出品か分からない行は触らない(他アカウントの出品を取り下げないため)。
      let delistSkippedUnknownSeller = 0
      for (const l of listings ?? []) {
        const token = resolveListingToken(l.seller_account_id as string | null)
        if (!token) { delistSkippedUnknownSeller++; continue }
        const siteId = (l.site_id as string | null) ?? 'US'
        if (l.product_id) quantityZeroEntries.push({ itemId: l.ebay_item_id as string, quantity: 0, siteId, sellerAccountId: (l.seller_account_id as string | null) ?? null })
        else delistResults.push(await endItem(token, l.ebay_item_id, siteId))
      }
      // 4件ずつまとめて在庫0にする(件数が多くても時間内に終わるように)。
      // セラーが違うとトークンが違うため、セラー単位で送る。
      for (const [accountId, entries] of groupEntriesBySeller(quantityZeroEntries)) {
        const token = resolveListingToken(accountId)
        if (!token) continue
        delistResults.push(...(await reviseInventoryStatusBatch(token, entries)).results)
      }
      // 実行履歴のCSV出力用に1件ごとの結果を残す
      const delistItems = delistResults.map(r => ({
        ebay_item_id: r.itemId,
        action: quantityZeroEntries.some(e => e.itemId === r.itemId) ? 'Revise' : 'End',
        reason: 'sold_out',
        success: r.success,
        error: r.error ?? null,
      }))
      try {
        await markListingsDelisted(db, userId, delistResults.filter(r => r.success).map(r => r.itemId))
      } catch {
        // 記録の失敗で取り下げ結果自体は変わらないため続行する
      }
      userResult.delist = { total: delistResults.length, succeeded: delistResults.filter(r => r.success).length, immediate: delistEligibility.immediate, skipped_unknown_seller: delistSkippedUnknownSeller, items: delistItems }
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
    if (settings.auto_revise_price && revisePriceThisSlot) {
      const { data: listings } = await db
        .from('inventory_active_listings')
        .select('ebay_item_id, current_price, product_id, seller_account_id, site_id, currency')
        .eq('user_id', userId)
        .not('product_id', 'is', null)

      const productIds = (listings ?? []).map(l => l.product_id as string)
      const productMap = new Map<string, { ebay_price: number | null; pricing_jpy_per_usd: number | null }>()
      if (productIds.length > 0) {
        const { data: products } = await db.from('products').select('id, ebay_price, pricing_jpy_per_usd').in('id', productIds)
        for (const p of products ?? []) productMap.set(p.id, p)
      }
      // UK/AU出品はUSD価格を出品通貨へ換算して反映する(維持した利益額はそのまま)
      const rates = await loadJpyRates((listings ?? []).map(l => ((l.currency as string | null) ?? 'USD')))

      // 本番で確認した不具合: 価格改定が135件になった日に、Vercelの実行時間
      // 上限(300秒)に達して途中で打ち切られ、実行ログも残らなかった。
      // 時間予算内で処理し、残りは翌日に回す(ログは必ず残す)。
      // 4件ずつまとめて並行に送り、時間予算内で処理し切れない分だけ翌日に回す。
      const reviseStartedAt = Date.now()
      const reviseEntries: Array<{ itemId: string; price: number; siteId: string | null; sellerAccountId: string | null }> = []
      const beforePrices = new Map<string, number>()
      // UK/AU出品は、維持している利益額(円)を出品通貨に換算した価格を送る。
      // 換算できない(レート未取得)・不自然に大きく下がる場合は送らず件数を残す。
      let reviseSkippedNoRate = 0
      let reviseGuarded = 0
      let reviseSkippedUnknownSeller = 0
      for (const l of listings ?? []) {
        const p = productMap.get(l.product_id!)
        const currency = ((l.currency as string | null) ?? 'USD').toUpperCase()
        const decision = decideSiteRevisePrice({
          currentPrice: l.current_price as number | null,
          usdPrice: p?.ebay_price ?? null,
          jpyPerUsd: p?.pricing_jpy_per_usd ?? null,
          siteId: (l.site_id as string | null) ?? 'US',
          jpyPerCurrency: rates.get(currency) ?? null,
        })
        if (decision.action === 'skip') {
          if (decision.reason === 'no_rate') reviseSkippedNoRate++
          if (decision.reason === 'guarded') {
            reviseGuarded++
            console.warn(`[inventory-auto] guarded: ${l.ebay_item_id} ${l.current_price} -> (${currency}) 計算結果が15%超の値下げ`)
          }
          continue
        }
        if (!resolveListingToken(l.seller_account_id as string | null)) { reviseSkippedUnknownSeller++; continue }
        reviseEntries.push({
          itemId: l.ebay_item_id as string,
          price: decision.price,
          siteId: (l.site_id as string | null) ?? 'US',
          sellerAccountId: (l.seller_account_id as string | null) ?? null,
        })
        beforePrices.set(l.ebay_item_id as string, Number(l.current_price))
      }
      const reviseResults: Array<{ itemId: string; success: boolean; error?: string }> = []
      let reviseDeferred = 0
      // セラーごとにトークンを分けて送る(サイトの違いはバッチ側でまとめる)
      for (const [accountId, entries] of groupEntriesBySeller(reviseEntries)) {
        const token = resolveListingToken(accountId)
        if (!token) { reviseSkippedUnknownSeller += entries.length; continue }
        const batch = await reviseInventoryStatusBatch(
          token, entries, { deadlineMs: reviseStartedAt + REVISE_PRICE_TIME_BUDGET_MS },
        )
        reviseResults.push(...batch.results)
        reviseDeferred += batch.deferred
      }
      // 反映した価格を在庫一覧の現在価格にも書く(次回同期を待たずに差分が消える)
      try {
        await applyRevisedPrices(db, userId, reviseResults.filter(r => r.success).map(r => {
          const entry = reviseEntries.find(e => e.itemId === r.itemId)
          return {
            ebay_item_id: r.itemId,
            price: entry?.price ?? 0,
            jpy_per_currency: entry ? rates.get(currencyForSite(entry.siteId)) ?? null : null,
          }
        }).filter(r => r.price > 0))
      } catch (error) {
        console.warn('[inventory-auto] revised price bookkeeping failed:', error instanceof Error ? error.message : error)
      }
      // 実行履歴のCSV出力用(公式ツールの revise ファイルと同じ内容)
      const reviseItems = reviseResults.map(r => {
        const after = reviseEntries.find(e => e.itemId === r.itemId)?.price ?? null
        const before = beforePrices.get(r.itemId) ?? null
        return {
          ebay_item_id: r.itemId,
          price_before: before,
          price_after: after,
          diff: after !== null && before !== null ? Math.round((after - before) * 100) / 100 : null,
          success: r.success,
          error: r.error ?? null,
        }
      })
      userResult.revise_price = {
        total: reviseResults.length,
        succeeded: reviseResults.filter(r => r.success).length,
        deferred: reviseDeferred,
        skipped_no_rate: reviseSkippedNoRate,
        guarded: reviseGuarded,
        skipped_unknown_seller: reviseSkippedUnknownSeller,
        items: reviseItems,
      }
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
