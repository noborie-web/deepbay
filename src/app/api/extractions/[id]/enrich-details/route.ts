import { NextRequest, NextResponse } from 'next/server'
import * as cheerio from 'cheerio'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { YahooFleaScraper, FLEA_DETAIL_PER_RUN, FLEA_RATE_LIMIT_WINDOW_MS } from '@/lib/scrapers/yahoo_flea'
import { YahooAuctionScraper } from '@/lib/scrapers/yahoo_auction'
import { fetchWithRetry, mapThrottled, RateLimitedError } from '@/lib/scrapers/throttled-fetch'
import { generateDescriptionsSafely, normalizeAiDescriptionMode, translateDescriptionsWithFailures } from '@/lib/translate'
import type { ScrapedProduct } from '@/lib/scrapers/types'

// ユーザー要望: ヤフオク・Yahoo!フリマの抽出で「必要なものは取得できるように」。
// 実データで確認した不具合: 抽出中に商品ページを並行取得するとYahoo!フリマから
// 429で拒否され、263件中248件の説明文・状態・評価数が空のまま登録された。
// 抽出中の取得は時間予算内に抑え、取り切れなかった分をこのAPIで抽出完了後に
// 少しずつ(1回あたり最大 BATCH 件、約45秒)補完する。UIが残り0件になるまで
// 繰り返し呼ぶ。
//  mode=status : 未補完の件数
//  mode=run    : 未補完の商品を補完する(説明文は抽出設定に従って英訳)
export const maxDuration = 60

const BATCH = 30
const TIME_BUDGET_MS = 42_000
// 実データで計測(2026-09-21): Yahoo!フリマは1つのIPから約15件で429になり約15分
// ブロックされる。1回の呼び出しでは FLEA_DETAIL_PER_RUN 件だけ1件ずつ取得し、
// 429が出たら打ち切って呼び出し側に「15分後に再開」を返す。
const SITE_PACING: Record<string, { concurrency: number; intervalMs: number; retries: number; maxPerRun: number }> = {
  yahoo_flea: { concurrency: 1, intervalMs: 1000, retries: 0, maxPerRun: FLEA_DETAIL_PER_RUN },
  yahoo_auction: { concurrency: 3, intervalMs: 250, retries: 2, maxPerRun: BATCH },
}
const ENRICHABLE_SITES = Object.keys(SITE_PACING)
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface PendingProduct {
  id: string
  source_url: string
  source_site: string
  original_description: string | null
  ebay_description: string | null
  original_images: string[] | null
}

async function countPending(db: ReturnType<typeof admin>, userId: string, extractionId: string): Promise<number> {
  const { count } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('extraction_id', extractionId)
    .in('source_site', ENRICHABLE_SITES)
    .is('detail_enriched_at', null)
  return count ?? 0
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { mode?: string }
  const mode = body.mode ?? 'status'
  const db = admin()

  if (mode === 'status') {
    return NextResponse.json({ ok: true, pending: await countPending(db, user.id, extractionId) })
  }
  if (mode !== 'run') return NextResponse.json({ error: `不明な mode: ${mode}` }, { status: 400 })

  const { data: rows, error } = await db
    .from('products')
    .select('id, source_url, source_site, original_description, ebay_description, original_images')
    .eq('user_id', user.id)
    .eq('extraction_id', extractionId)
    .in('source_site', ENRICHABLE_SITES)
    .is('detail_enriched_at', null)
    .order('created_at', { ascending: true })
    .limit(BATCH)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const targets = (rows ?? []) as PendingProduct[]
  if (targets.length === 0) return NextResponse.json({ ok: true, processed: 0, failed: 0, pending: 0 })

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
  const failedIds: string[] = []
  const enriched: Array<{ product: PendingProduct; detail: ScrapedProduct }> = []

  // サイトごとにアクセス間隔を分けて取得する
  for (const site of ENRICHABLE_SITES) {
    const pacing = SITE_PACING[site]
    const siteTargets = targets.filter(t => t.source_site === site).slice(0, pacing.maxPerRun)
    if (siteTargets.length === 0) continue
    const remainingBudget = TIME_BUDGET_MS - (Date.now() - startedAt)
    if (remainingBudget <= 0) break
    let stop = false
    const { results } = await mapThrottled(siteTargets.map(t => ({ target: t, detail: null as ScrapedProduct | null, failed: false })), async (entry) => {
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
          // 制限中は「試みた」扱いにせず、次回(15分後)に回す
          stop = true
          if (site === 'yahoo_flea') fleaRateLimited = true
          return entry
        }
        console.error('[enrich-details] failed for', entry.target.id, err instanceof Error ? err.message : err)
        return { ...entry, failed: true }
      }
    }, { concurrency: pacing.concurrency, intervalMs: pacing.intervalMs, timeBudgetMs: remainingBudget })
    for (const r of results) {
      if (r.detail) enriched.push({ product: r.target, detail: r.detail })
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
  // 取得に失敗した商品も「試みた」として記録し、無限に再試行しない
  if (failedIds.length > 0) {
    await db.from('products').update({ detail_enriched_at: now }).in('id', failedIds).eq('user_id', user.id)
  }

  const pending = await countPending(db, user.id, extractionId)
  const { count: fleaPending } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('extraction_id', extractionId)
    .eq('source_site', 'yahoo_flea')
    .is('detail_enriched_at', null)
  return NextResponse.json({
    ok: true,
    processed,
    failed,
    pending,
    flea_pending: fleaPending ?? 0,
    // Yahoo!フリマの制限に達した(または1回分を取り切った)ら、次の呼び出しまで待つ時間
    retry_after_ms: (fleaPending ?? 0) > 0 && (fleaRateLimited || processed > 0) ? FLEA_RATE_LIMIT_WINDOW_MS : 0,
    flea_rate_limited: fleaRateLimited,
  })
}
