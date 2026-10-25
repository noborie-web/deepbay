import * as cheerio from 'cheerio'
import type { SupabaseClient } from '@supabase/supabase-js'
import { YahooFleaScraper, FLEA_DETAIL_PER_RUN, FLEA_RATE_LIMIT_WINDOW_MS } from '@/lib/scrapers/yahoo_flea'
import { YahooAuctionScraper } from '@/lib/scrapers/yahoo_auction'
import { MercariScraper } from '@/lib/scrapers/mercari'
import { fetchShopProductDetail } from '@/lib/scrapers/mercari_shops'
import { launchHeadlessBrowser } from '@/lib/scrapers/headless-browser'
import { fetchWithRetry, mapThrottled, RateLimitedError } from '@/lib/scrapers/throttled-fetch'
import { generateDescriptionsSafely, normalizeAiDescriptionMode, translateDescriptionsWithFailures } from '@/lib/translate'
import { ScraperError, type ScrapedProduct } from '@/lib/scrapers/types'
import { ENRICHABLE_SITES, type EnrichableSite } from '@/lib/enrich-sites'

// ユーザー要望: ヤフオク・Yahoo!フリマの抽出で「必要なものは取得できるように」。
// 実データで確認した不具合: 抽出中に商品ページを並行取得するとYahoo!フリマから
// 429で拒否され、263件中248件の説明文・状態・評価数が空のまま登録された。
// 抽出中の取得は時間予算内に抑え、取り切れなかった分をこのAPIで抽出完了後に
// 少しずつ(1回あたり最大 BATCH 件、約45秒)補完する。UIが残り0件になるまで
// 繰り返し呼ぶ。
// ユーザー要望(2026-10-15): 抽出結果のページを開かなくても補完が進むようにしたい。
// 画面(ページを開いているあいだ)と定期実行(cron)の両方から同じ処理を呼べるよう、
// ルートから切り出した。Next.jsのroute.tsはHTTPハンドラ以外をexportできない。

// ユーザー報告(2026-10-19): 補完に時間がかかりすぎる。
// ヤフオクはYahoo!フリマほど制限が厳しくないので、1回の処理件数を上げる。
// 時間予算(42秒)の範囲で収まる値にしている(並列4・間隔250ms)。
const BATCH = 120
const TIME_BUDGET_MS = 42_000
// 実データで計測(2026-09-21): Yahoo!フリマは1つのIPから約15件で429になり約15分
// ブロックされる。1回の呼び出しでは FLEA_DETAIL_PER_RUN 件だけ1件ずつ取得し、
// 429が出たら打ち切って呼び出し側に「15分後に再開」を返す。
// 対象サイトは一覧の集計(extraction_enrich_pending)と共通にする。
// ここで Record<EnrichableSite, ...> にしておくと、サイトを増やしたときに
// ペース設定の追加漏れをTypeScriptが知らせてくれる。
const SITE_PACING: Record<EnrichableSite, { concurrency: number; intervalMs: number; retries: number; maxPerRun: number }> = {
  // フリマは1つのIPから約15件/15分しか見せないため据え置き
  yahoo_flea: { concurrency: 1, intervalMs: 1000, retries: 0, maxPerRun: FLEA_DETAIL_PER_RUN },
  yahoo_auction: { concurrency: 4, intervalMs: 250, retries: 2, maxPerRun: BATCH },
  // メルカリは商品ページ1件につき連番画像の存在確認(最大12回のHEAD)が走るので、
  // ヤフオクより控えめにする
  mercari: { concurrency: 2, intervalMs: 500, retries: 1, maxPerRun: BATCH },
}
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 本番で確認した不具合(2026-10-25): メルカリShopsの商品URLは
// jp.mercari.com/shops/product/{id} で、通常のメルカリ(jp.mercari.com/item/{id})
// とは別物。MercariScraper はこのURLを受け取れず「Invalid Mercari URL」を投げる
// ため、Shops商品は何度試しても補完できなかった(19件)。
// さらに補完cronは「いちばん古い抽出を1つだけ」進めるので、この19件を含む抽出が
// 毎回選ばれ、ほかの192件の補完まで止めていた。
// Shopsのページは価格・説明文・画像がクライアントサイドレンダリングで、
// HTMLには og:image の1枚しか載らない。ヘッドレスブラウザが要る。
const MERCARI_SHOPS_URL = /\/shops\/product\/([a-zA-Z0-9]+)/
// 実測(2026-10-25): 起動に約2秒、1件あたり約2.4秒。cronの実行時間上限(60秒)と
// 時間予算(42秒)に収まる件数に抑える。残りは次の回に回る。
const MERCARI_SHOPS_PER_RUN = 8
// 1件あたりの上限。実測2.4秒なので、これに当たるのは開かないページだけ。
const MERCARI_SHOPS_ITEM_MS = 10_000
// 時間予算(42秒)のうちShopsに回す上限。残りは通常の取得に渡す。
const MERCARI_SHOPS_BUDGET_MS = 24_000
// 次の1件に入るかどうかの判断に使う見積もり。ここに上限(10秒)を使うと
// 実測2.4秒の処理が1回あたり2件しか進まなくなるため、実測に余裕を足した値にする。
const MERCARI_SHOPS_ITEM_ESTIMATE_MS = 6_000

interface PendingProduct {
  id: string
  source_url: string
  source_site: string
  original_description: string | null
  ebay_description: string | null
  original_images: string[] | null
  detail_attempts: number | null
  detail_retry_after: string | null
}

// ユーザー要望(2026-10-17): 抽出を削除した商品も補完したい。
// 抽出一覧から抽出を消すと products.extraction_id は null になる
// (ON DELETE SET NULL。商品はeBay出品中なので残す)。補完は抽出単位で動くため、
// それらが対象から漏れていた。extractionId に null を渡すと
// 「そのユーザーの、抽出が消えた商品」をまとめて扱う。
export type EnrichTarget = string | null

// 絞り込みを1つ足すだけだが、Supabaseのクエリ型をそのまま通すと型の展開が
// 深くなりすぎてコンパイルできないため、ここだけ型を緩める。
/* eslint-disable @typescript-eslint/no-explicit-any */
function scopeToTarget(query: any, extractionId: EnrichTarget): any {
  return extractionId === null ? query.is('extraction_id', null) : query.eq('extraction_id', extractionId)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function countPending(db: SupabaseClient, userId: string, extractionId: EnrichTarget): Promise<number> {
  const { count } = await scopeToTarget(db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId), extractionId)
    .in('source_site', [...ENRICHABLE_SITES])
    .is('detail_enriched_at', null)
  return count ?? 0
}

// 本番で確認した不具合(2026-09-22): ヤフオク商品ページの取得が連続で失敗した
// 98件を「試みた」扱いにして二度と再試行しなかった(説明文・画像が1枚のまま)。
// 失敗した商品は 10分×試行回数 後に再試行し、5回失敗して初めて諦める。
const MAX_DETAIL_ATTEMPTS = 5
const RETRY_BASE_MS = 10 * 60 * 1000


export interface EnrichBatchResult {
  processed: number
  failed: number
  pending: number
  fleaPending: number
  retryAfterMs: number
  fleaRateLimited: boolean
}

/**
 * 未補完の商品を1回ぶん(最大 BATCH 件・約45秒)補完する。
 * 画面からも定期実行(cron)からも同じ処理を使う。
 */
export async function runEnrichDetailsBatch(
  db: SupabaseClient,
  user: { id: string },
  extractionId: EnrichTarget,
): Promise<EnrichBatchResult> {
  const nowIso = new Date().toISOString()
  const { data: rows, error } = await scopeToTarget(db
    .from('products')
    .select('id, source_url, source_site, original_description, ebay_description, original_images, detail_attempts, detail_retry_after')
    .eq('user_id', user.id), extractionId)
    .in('source_site', [...ENRICHABLE_SITES])
    .is('detail_enriched_at', null)
    .or(`detail_retry_after.is.null,detail_retry_after.lte.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(BATCH)
  if (error) throw new Error(error.message)
  const targets = (rows ?? []) as PendingProduct[]
  if (targets.length === 0) {
    // 再試行待ちの商品があれば、次に試せる時刻を返す
    const { data: waiting } = await scopeToTarget(db
      .from('products')
      .select('detail_retry_after')
      .eq('user_id', user.id), extractionId)
      .in('source_site', [...ENRICHABLE_SITES])
      .is('detail_enriched_at', null)
      .not('detail_retry_after', 'is', null)
      .order('detail_retry_after', { ascending: true })
      .limit(1)
      .maybeSingle()
    const pending = await countPending(db, user.id, extractionId)
    const retryAfterMs = waiting?.detail_retry_after ? Math.max(0, new Date(waiting.detail_retry_after as string).getTime() - Date.now()) : 0
    return { processed: 0, failed: 0, pending, fleaPending: 0, retryAfterMs: pending > 0 ? retryAfterMs + 1000 : 0, fleaRateLimited: false }
  }

  const { data: settings } = await db
    .from('extraction_settings')
    .select('description_engine, description_enabled, ai_description_mode')
    .eq('user_id', user.id)
    .maybeSingle()
  const descriptionEnabled: boolean = settings?.description_enabled ?? true
  const descriptionEngine: string = settings?.description_engine ?? 'high'
  const aiDescriptionMode = normalizeAiDescriptionMode(settings?.ai_description_mode)

  const flea = new YahooFleaScraper()
  const auction = new YahooAuctionScraper()
  const mercari = new MercariScraper()
  // サイトとパーサーの対応。ENRICHABLE_SITES に足したのにここへ足し忘れると、
  // 別サイトのパーサーで解析して「空の成功」になる(2026-10-25のメルカリ)。
  // 未対応のサイトは黙って他のパーサーに回さず、はっきり失敗させる。
  const parseFetchedDetail = ($: cheerio.CheerioAPI, site: EnrichableSite, url: string): ScrapedProduct => {
    if (site === 'yahoo_flea') return flea.parse($, url)
    if (site === 'yahoo_auction') return auction.parse($, url)
    throw new Error(`補完のパーサーが未対応のサイト: ${site}`)
  }
  const startedAt = Date.now()
  let failed = 0
  let fleaRateLimited = false
  let auctionRateLimited = false
  const failedIds: string[] = []
  // 出品が終了して消えたページ(404)は、何度試しても成功しない。
  // 再試行せずその場で打ち切る(ユーザー報告 2026-10-19: 終了した出品を
  // 5回・最大2.5時間かけて再試行し、補完がいつまでも終わらなかった)。
  const goneIds: string[] = []
  const enriched: Array<{ product: PendingProduct; detail: ScrapedProduct }> = []

  // メルカリShopsだけは取得経路が違う(ヘッドレスブラウザ)ので、通常の
  // サイトごとの取得からは外して別に処理する。
  const shopsTargets = targets.filter(t => t.source_site === 'mercari' && MERCARI_SHOPS_URL.test(t.source_url))
  const shopsIds = new Set(shopsTargets.map(t => t.id))

  // メルカリShopsの補完。1件ごとにブラウザを起動すると遅すぎるので、
  // この回のぶんをまとめて1つのブラウザで処理する。
  //
  // 本番で確認した不具合(2026-10-25): この処理を通常のサイト取得の「あと」に
  // 置いていたため、一度も動かなかった。通常のメルカリの取得だけで時間予算
  // (42秒)を使い切るので(実行の終了時刻が毎回開始から52秒)、残り時間はいつも
  // 0だった。Shopsは件数が少なく放っておくと永久に補完されないため、先に
  // 専用の予算ぶんだけ処理してから、残りを通常の取得に渡す。
  const shopsDeadline = startedAt + MERCARI_SHOPS_BUDGET_MS
  if (shopsTargets.length > 0) {
    const batch = shopsTargets.slice(0, MERCARI_SHOPS_PER_RUN)
    let browser: Awaited<ReturnType<typeof launchHeadlessBrowser>> | undefined
    try {
      browser = await launchHeadlessBrowser()
      for (const target of batch) {
        if (shopsDeadline - Date.now() < MERCARI_SHOPS_ITEM_ESTIMATE_MS) break
        const itemId = target.source_url.match(MERCARI_SHOPS_URL)?.[1]
        if (!itemId) { failed += 1; failedIds.push(target.id); continue }
        try {
          const detail = await fetchShopProductDetail(browser, itemId, { userAgent: USER_AGENT, timeoutMs: MERCARI_SHOPS_ITEM_MS })
          // 取れていないのに「補完済み」にしない(通常の経路と同じ扱い)
          if (!detail || (!detail.description?.trim() && detail.images.length === 0)) {
            console.error('[enrich-details] empty detail for', target.id, 'mercari_shops')
            failed += 1
            failedIds.push(target.id)
            continue
          }
          enriched.push({ product: target, detail })
        } catch (err) {
          console.error('[enrich-details] failed for', target.id, err instanceof Error ? err.message : err)
          failed += 1
          failedIds.push(target.id)
        }
      }
    } catch (err) {
      // ブラウザを起動できない環境では、黙って「補完済み」にせず次回に回す
      console.error('[enrich-details] headless browser unavailable:', err instanceof Error ? err.message : err)
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  // サイトごとにアクセス間隔を分けて取得する
  for (const site of ENRICHABLE_SITES) {
    const pacing = SITE_PACING[site]
    const siteTargets = targets.filter(t => t.source_site === site && !shopsIds.has(t.id)).slice(0, pacing.maxPerRun)
    if (siteTargets.length === 0) continue
    const remainingBudget = TIME_BUDGET_MS - (Date.now() - startedAt)
    if (remainingBudget <= 0) break
    let stop = false
    const { results } = await mapThrottled(siteTargets.map(t => ({ target: t, detail: null as ScrapedProduct | null, failed: false, gone: false })), async (entry) => {
      if (stop) return entry
      try {
        // 本番で確認した不具合(2026-10-25): メルカリを補完対象に加えた際、
        // ここにメルカリの分岐を足し忘れていた。メルカリのHTMLをヤフオクの
        // パーサーに渡していたため、画像0枚・説明文なしの「空の成功」が
        // 返り、detail_enriched_at だけが付いて補完済みになっていた。
        // 389件が検索結果のサムネ1枚のまま固定されていた。
        //
        // メルカリの単品ページはSPAでHTMLに中身が無く、専用の取得経路
        // (items/get、失敗時は画像の連番確認)が要る。スクレイパーに任せる。
        const detail = site === 'mercari'
          ? (await mercari.scrape(entry.target.source_url, { limit: 1 }))[0]
          : parseFetchedDetail(
            cheerio.load(await fetchWithRetry(entry.target.source_url, {
              userAgent: USER_AGENT, timeoutMs: 15000, intervalMs: pacing.intervalMs, retries: pacing.retries, siteKey: site,
            })),
            site,
            entry.target.source_url,
          )
        // 取れていないのに「補完済み」にしない。説明文も画像も無い結果は、
        // パーサーの取り違えやページ構造の変更で中身を拾えていない状態なので、
        // 失敗として扱って再試行に回す(上の取り違えを二度と黙って通さない)。
        if (!detail || (!detail.description?.trim() && detail.images.length === 0)) {
          console.error('[enrich-details] empty detail for', entry.target.id, site)
          return { ...entry, failed: true, gone: false }
        }
        return { ...entry, detail }
      } catch (err) {
        if (err instanceof RateLimitedError) {
          // 制限中は「試みた」扱いにせず、次回に回す(フリマは15分後、ヤフオクは数分後)
          stop = true
          if (site === 'yahoo_flea') fleaRateLimited = true
          else auctionRateLimited = true
          return entry
        }
        // 404(出品が終了してページが消えた)は再試行しても無駄
        const gone = err instanceof ScraperError && (err as ScraperError).status === 404
        if (!gone) {
          console.error('[enrich-details] failed for', entry.target.id, err instanceof Error ? err.message : err)
        }
        return { ...entry, failed: true, gone }
      }
    }, { concurrency: pacing.concurrency, intervalMs: pacing.intervalMs, timeBudgetMs: remainingBudget })
    for (const r of results) {
      if (r.detail) enriched.push({ product: r.target, detail: r.detail })
      else if (r.gone) { failed += 1; goneIds.push(r.target.id) }
      else if (r.failed) { failed += 1; failedIds.push(r.target.id) }
      // 時間切れで未処理のものは detail_enriched_at を付けず次回に回す
    }
  }

  // 説明文の英訳(抽出時と同じ設定)。AI生成が 'all' なら元の説明文を材料に生成し直す
  const descriptions = enriched.map(e => e.detail.description ?? '')
  let translated: string[] = [...descriptions]
  if (descriptionEnabled && process.env.OPENAI_API_KEY && descriptions.some(d => d.trim())) {
    try {
      translated = (await translateDescriptionsWithFailures(descriptions, descriptionEngine)).map(r => r.description)
    } catch (err) {
      console.error('[enrich-details] description translation failed:', err instanceof Error ? err.message : err)
    }
  }
  if (aiDescriptionMode === 'all' && process.env.OPENAI_API_KEY && enriched.length > 0) {
    try {
      const generated = await generateDescriptionsSafely(enriched.map(({ detail }) => {
        const raw = (detail.rawData ?? {}) as Record<string, unknown>
        return {
          title: detail.title,
          condition: detail.condition,
          category: detail.category,
          brand: typeof raw.brand === 'string' ? raw.brand : null,
          hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.filter((t): t is string => typeof t === 'string') : null,
          originalDescription: detail.description,
        }
      }), descriptionEngine)
      generated.forEach((g, i) => { if (g.description) translated[i] = g.description })
    } catch (err) {
      console.error('[enrich-details] description generation failed:', err instanceof Error ? err.message : err)
    }
  }

  const now = new Date().toISOString()
  let processed = 0
  for (let i = 0; i < enriched.length; i++) {
    const { product, detail } = enriched[i]
    const update: Record<string, unknown> = { detail_enriched_at: now }
    if (detail.description && !product.original_description) {
      update.original_description = detail.description
      // 抽出時にAIで仮生成した説明文があっても、本物の説明文(翻訳/生成)で置き換える
      update.ebay_description = translated[i] || detail.description
    }
    if (detail.condition) { update.original_condition = detail.condition; update.ebay_condition = detail.condition }
    if (detail.sellerRatingCount !== null) update.seller_rating_count = detail.sellerRatingCount
    if (detail.shippingDays !== null) update.shipping_days = detail.shippingDays
    if (detail.sourceUpdatedAt) update.source_updated_at = detail.sourceUpdatedAt
    if (detail.sellerUrl) update.seller_url = detail.sellerUrl
    if (detail.images.length > (product.original_images?.length ?? 0)) {
      update.original_images = detail.images
      update.ebay_images = detail.images
    }
    if (detail.rawData) update.raw_source_data = detail.rawData
    const { error: updateError } = await db.from('products').update(update).eq('id', product.id).eq('user_id', user.id)
    if (updateError) { failed += 1; continue }
    processed += 1
  }
  // 取得に失敗した商品は時間を置いて再試行する(5回失敗したら諦める)
  // 出品が消えている分は、ここで打ち切って補完待ちから外す
  for (const id of goneIds) {
    await db.from('products').update({
      detail_enriched_at: now,
      detail_attempts: (targets.find(t => t.id === id)?.detail_attempts ?? 0) + 1,
      detail_retry_after: null,
    }).eq('id', id).eq('user_id', user.id)
  }

  for (const id of failedIds) {
    const target = targets.find(t => t.id === id)
    const attempts = (target?.detail_attempts ?? 0) + 1
    await db.from('products').update(
      attempts >= MAX_DETAIL_ATTEMPTS
        ? { detail_enriched_at: now, detail_attempts: attempts }
        : { detail_attempts: attempts, detail_retry_after: new Date(Date.now() + RETRY_BASE_MS * attempts).toISOString() },
    ).eq('id', id).eq('user_id', user.id)
  }

  const pending = await countPending(db, user.id, extractionId)
  const { count: fleaPending } = await scopeToTarget(db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id), extractionId)
    .eq('source_site', 'yahoo_flea')
    .is('detail_enriched_at', null)
  return {
    processed,
    failed,
    pending,
    fleaPending: fleaPending ?? 0,
    // Yahoo!フリマの制限に達した(または1回分を取り切った)ら、次の呼び出しまで待つ時間
    retryAfterMs: (fleaPending ?? 0) > 0 && (fleaRateLimited || processed > 0)
      ? FLEA_RATE_LIMIT_WINDOW_MS
      : (auctionRateLimited || (processed === 0 && failed > 0 && pending > 0)) ? 5 * 60 * 1000 : 0,
    fleaRateLimited,
  }
}
