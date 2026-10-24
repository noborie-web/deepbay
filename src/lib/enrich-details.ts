import * as cheerio from 'cheerio'
import type { SupabaseClient } from '@supabase/supabase-js'
import { YahooFleaScraper, FLEA_DETAIL_PER_RUN, FLEA_RATE_LIMIT_WINDOW_MS } from '@/lib/scrapers/yahoo_flea'
import { YahooAuctionScraper } from '@/lib/scrapers/yahoo_auction'
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

  // サイトごとにアクセス間隔を分けて取得する
  for (const site of ENRICHABLE_SITES) {
    const pacing = SITE_PACING[site]
    const siteTargets = targets.filter(t => t.source_site === site).slice(0, pacing.maxPerRun)
    if (siteTargets.length === 0) continue
    const remainingBudget = TIME_BUDGET_MS - (Date.now() - startedAt)
    if (remainingBudget <= 0) break
    let stop = false
    const { results } = await mapThrottled(siteTargets.map(t => ({ target: t, detail: null as ScrapedProduct | null, failed: false, gone: false })), async (entry) => {
      if (stop) return entry
      try {
        const html = await fetchWithRetry(entry.target.source_url, {
          userAgent: USER_AGENT, timeoutMs: 15000, intervalMs: pacing.intervalMs, retries: pacing.retries, siteKey: site,
        })
        const $ = cheerio.load(html)
        const detail = site === 'yahoo_flea' ? flea.parse($, entry.target.source_url) : auction.parse($, entry.target.source_url)
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
