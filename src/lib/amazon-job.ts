import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchAmazonProducts } from '@/lib/amazon-extract'
import { mergeExclusionSummaries, runScrape } from '@/lib/extraction-run'

// ユーザー要望(2026-10-14): Amazon抽出の1回300件という上限を上げたい。
//
// 300件は計算の結果ぴったりの値で、1回の実行では動かせない:
//   getItemOffersBatch のレート制限 0.1 req/s × 20 ASIN/回 = 実効2 ASIN/s
//   価格取得に使える150秒 × 2 ASIN/s = 300 ASIN
// 残り150秒は翻訳・価格計算・保存に使い、全体をVercelの実行時間上限
// (Hobbyは300秒)に収める必要がある。
//
// レート制限はアカウント単位なので、分割しても速くはならない
// (1,000件はどうやっても約8分半かかる)。分割でできるのは
// 「1回の実行時間の壁を超えること」だけ。

/** 1チャンクのASIN数。2 ASIN/s × 150秒 = 300件 */
export const CHUNK_SIZE = 300
/** 1チャンクの価格取得に割ける時間 */
export const CHUNK_FETCH_BUDGET_MS = 150_000
/** 1チャンク全体(価格取得＋翻訳・保存)の持ち時間 */
export const CHUNK_TOTAL_BUDGET_MS = 270_000
/**
 * 自動継続が途切れたとみなすまでの時間。
 * 1チャンクは最長270秒なので、その2倍を見ておく。
 */
export const STALLED_AFTER_MS = 10 * 60 * 1000

export interface AmazonExtractJob {
  id: string
  user_id: string
  extraction_id: string
  asins: string[]
  next_index: number
  chunk_size: number
  fba_only: boolean
  bulk_edit_setting_id: string | null
  status: string
  summary: Record<string, unknown>
}

export interface ChunkResult {
  /** 全チャンクが終わった */
  done: boolean
  /** このチャンクで処理したASIN数 */
  processed: number
  /** 次に処理する位置 */
  nextIndex: number
  total: number
}

export async function loadJob(db: SupabaseClient, jobId: string): Promise<AmazonExtractJob | null> {
  const { data, error } = await db
    .from('amazon_extract_jobs')
    .select('id, user_id, extraction_id, asins, next_index, chunk_size, fba_only, bulk_edit_setting_id, status, summary')
    .eq('id', jobId)
    .maybeSingle()
  if (error) throw new Error(`抽出ジョブの取得に失敗しました: ${error.message}`)
  return (data as AmazonExtractJob | null) ?? null
}

/**
 * ジョブの次の1チャンクを処理する。
 *
 * 1回の呼び出しで1チャンクだけ進めて結果を返す。続きがあるかは done で分かる
 * ので、呼び出し側が次の実行を起動する(実行時間の上限を超えられないため)。
 */
export async function runAmazonExtractChunk(
  db: SupabaseClient,
  jobId: string,
  options: { signal?: AbortSignal; startedAt?: number } = {},
): Promise<ChunkResult> {
  const job = await loadJob(db, jobId)
  if (!job) throw new Error('抽出ジョブが見つかりません')
  if (job.status === 'completed') {
    return { done: true, processed: 0, nextIndex: job.next_index, total: job.asins.length }
  }

  const startedAt = options.startedAt ?? Date.now()
  const total = job.asins.length
  const from = job.next_index
  const chunk = job.asins.slice(from, from + job.chunk_size)

  if (chunk.length === 0) {
    await finishJob(db, job, job.summary)
    return { done: true, processed: 0, nextIndex: from, total }
  }

  await db.from('amazon_extract_jobs')
    .update({ status: 'running', last_progress_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', job.id)

  const fetched = await fetchAmazonProducts(db, job.user_id, chunk, {
    timeBudgetMs: CHUNK_FETCH_BUDGET_MS,
    fbaOnly: job.fba_only,
    signal: options.signal,
  })

  // 時間切れで処理しなかったASINは、次のチャンクで必ず拾い直す
  // (「取れなかった」を「0件だった」として確定させない)
  const processed = chunk.length - fetched.skipped.length
  const nextIndex = from + processed
  const isLast = nextIndex >= total

  const chunkSummary = {
    amazon_requested: chunk.length - fetched.skipped.length,
    amazon_no_new_offer: fetched.noOffer.length,
    amazon_not_fba: fetched.notFba.length,
    amazon_pricing_failed: fetched.pricingFailed.length,
    amazon_no_new_offer_asins: fetched.noOffer,
    amazon_not_fba_asins: fetched.notFba,
    amazon_pricing_failed_asins: fetched.pricingFailed,
  }

  // 進捗バーはASINの処理済み割合に合わせる(チャンクをまたいでも戻らない)
  const progressFrom = Math.round((from / total) * 100)
  const progressTo = Math.round((nextIndex / total) * 100)

  let summary: Record<string, unknown>
  if (fetched.products.length === 0) {
    // このチャンクは1件も取り込めなかった。抽出は続けるので失敗にはしない
    summary = mergeExclusionSummaries(job.summary, chunkSummary)
    await db.from('extractions')
      .update({ progress: progressTo, exclusion_summary: summary })
      .eq('id', job.extraction_id)
  } else {
    const result = await runScrape(
      job.user_id,
      job.extraction_id,
      `amazon:asin-list:${total}`,
      job.bulk_edit_setting_id,
      db,
      {
        deadlineAt: startedAt + CHUNK_TOTAL_BUDGET_MS,
        presetProducts: fetched.products,
        extraExclusionSummary: chunkSummary,
        previousExclusionSummary: job.summary,
        progressRange: { from: progressFrom, to: progressTo },
        finalize: isLast,
      },
    )
    if (result.status === 'failed') throw new Error(result.errorMessage)
    summary = result.status === 'completed' ? result.exclusionSummary : mergeExclusionSummaries(job.summary, chunkSummary)
  }

  const now = new Date().toISOString()
  if (isLast) {
    await finishJob(db, { ...job, next_index: nextIndex }, summary)
    // 1件も取り込めずに終わった場合だけ、理由を抽出に残して失敗にする
    if (fetched.products.length === 0 && from === 0) {
      await db.from('extractions')
        .update({ status: 'failed', progress: 0, error_message: amazonEmptyReason(summary) })
        .eq('id', job.extraction_id)
    }
    return { done: true, processed, nextIndex, total }
  }

  await db.from('amazon_extract_jobs')
    .update({
      next_index: nextIndex,
      summary,
      status: 'pending',
      last_progress_at: now,
      updated_at: now,
      last_error: null,
    })
    .eq('id', job.id)

  return { done: false, processed, nextIndex, total }
}

async function finishJob(
  db: SupabaseClient,
  job: AmazonExtractJob,
  summary: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString()
  await db.from('amazon_extract_jobs')
    .update({
      next_index: job.next_index,
      summary,
      status: 'completed',
      last_progress_at: now,
      updated_at: now,
      last_error: null,
    })
    .eq('id', job.id)
}

export async function markJobFailed(db: SupabaseClient, jobId: string, message: string): Promise<void> {
  const now = new Date().toISOString()
  await db.from('amazon_extract_jobs')
    .update({ status: 'failed', last_error: message.slice(0, 500), last_progress_at: now, updated_at: now })
    .eq('id', jobId)
}

function amazonEmptyReason(summary: Record<string, unknown>): string {
  const num = (key: string): number => (typeof summary[key] === 'number' ? summary[key] as number : 0)
  const parts: string[] = []
  if (num('amazon_no_new_offer') > 0) parts.push(`新品の出品が無い: ${num('amazon_no_new_offer')}件`)
  if (num('amazon_not_fba') > 0) parts.push(`FBAの出品が無い: ${num('amazon_not_fba')}件（「FBAのみ」を外すと対象になります）`)
  if (num('amazon_pricing_failed') > 0) parts.push(`価格を取得できなかった: ${num('amazon_pricing_failed')}件（再実行で取得できることがあります）`)
  return `取り込める商品がありませんでした。${parts.join(' / ')}`
}

/**
 * 次のチャンクの実行を起動する。
 *
 * Vercelの実行時間上限を超えられないため、1チャンク終わるごとに自分の
 * 継続エンドポイントを呼び直して続ける。cronは Hobby では1日1回しか
 * 動かせないので、継続には使えない。
 *
 * 起動に失敗してもジョブは pending のまま残るので、画面の「続きを実行」
 * から再開できる(途中まで保存した商品は消えない)。
 */
export async function triggerNextChunk(
  origin: string,
  jobId: string,
  options: { secret?: string } = {},
): Promise<{ triggered: boolean; error?: string }> {
  const secret = options.secret ?? process.env.CRON_SECRET
  if (!secret) return { triggered: false, error: 'CRON_SECRET が設定されていません' }
  try {
    const res = await fetch(`${origin}/api/extract/amazon/continue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ jobId }),
    })
    if (!res.ok) return { triggered: false, error: `HTTP ${res.status}` }
    return { triggered: true }
  } catch (error) {
    return { triggered: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 1チャンク処理して、続きがあれば次の実行を起動する。
 *
 * Next.jsのroute.tsはHTTPハンドラ以外をexportできないので、ここに置く
 * (抽出の開始と継続の両方から同じ処理を呼ぶ)。
 * 継続の起動に失敗してもジョブは残るので、画面の「続きを実行」から再開できる。
 */
export async function processChunkAndChain(
  jobId: string,
  extractionId: string,
  origin: string,
): Promise<void> {
  const db = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const result = await runAmazonExtractChunk(db, jobId)
    if (!result.done) {
      const triggered = await triggerNextChunk(origin, jobId)
      if (!triggered.triggered) {
        console.warn(`[extract/amazon] failed to trigger next chunk: ${triggered.error}`)
      }
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : '不明なエラー').slice(0, 500)
    await markJobFailed(db, jobId, message)
    await db.from('extractions')
      .update({ status: 'failed', progress: 0, error_message: message })
      .eq('id', extractionId)
      .eq('status', 'processing')
  }
}
