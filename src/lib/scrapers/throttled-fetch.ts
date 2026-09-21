// 商品ページの個別取得を、相手サイトのレート制限に合わせて行うための共通処理。
//
// 実データで確認した不具合(2026-09-21): Yahoo!フリマの検索抽出で商品ページを
// 並行8件で取得したところ、数十件目から「429 Too Many Requests」で拒否され、
// 263件中248件の説明文・状態・評価数が空のまま登録された。
//  - 並行数を抑え、リクエスト間に間隔を置く
//  - 429/ネットワークエラーは待って再試行(429が続く場合は間隔を広げる)
//  - 全体の時間予算を超えたら残りは基本情報(タイトル・価格・画像)のままにする
import { ScraperError } from './types'

export interface ThrottledFetchOptions {
  userAgent: string
  timeoutMs: number
  // 1リクエストごとの最小間隔(ワーカーごと)
  intervalMs: number
  // 429・一時的なエラー時の再試行回数
  retries: number
  siteKey: string
}

export class RateLimitedError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}: Too Many Requests`)
    this.name = 'RateLimitedError'
  }
}

async function fetchOnce(url: string, options: ThrottledFetchOptions): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': options.userAgent, 'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3' },
      signal: controller.signal,
    })
    if (res.status === 429 || res.status === 503) throw new RateLimitedError(res.status)
    if (!res.ok) throw new ScraperError(`HTTP ${res.status}: ${res.statusText}`, options.siteKey, url)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 商品ページを取得する。429/ネットワークエラー時は 3秒・6秒・12秒…と待って再試行する。
 * 再試行しても失敗したら例外を投げる(呼び出し側で「基本情報のまま」にする)。
 */
export async function fetchWithRetry(url: string, options: ThrottledFetchOptions): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fetchOnce(url, options)
    } catch (error) {
      lastError = error
      const retryable = error instanceof RateLimitedError
        || (error instanceof Error && error.name !== 'ScraperError')
      if (!retryable || attempt === options.retries) throw error
      await sleep(3000 * 2 ** attempt)
    }
  }
  throw lastError
}

export interface ThrottledMapOptions {
  concurrency: number
  intervalMs: number
  // これを超えたら残りの要素は処理せず、そのまま(fallback)で返す
  timeBudgetMs?: number
  onProgress?: (done: number, total: number) => void
}

/**
 * 要素ごとに非同期処理を、並行数と間隔を抑えて実行する。
 * 時間予算を超えた要素には fn を適用せず元の値を返す。
 */
export async function mapThrottled<T>(
  items: T[],
  fn: (item: T) => Promise<T>,
  options: ThrottledMapOptions,
): Promise<{ results: T[]; skipped: number }> {
  const results: T[] = [...items]
  const startedAt = Date.now()
  let next = 0
  let done = 0
  let skipped = 0
  const workers = Math.max(1, Math.min(options.concurrency, items.length))
  await Promise.all(Array.from({ length: workers }, async (_, workerIndex) => {
    // ワーカーの開始をずらして同時アクセスの山を作らない
    await sleep(workerIndex * Math.floor(options.intervalMs / workers))
    while (next < items.length) {
      const index = next++
      if (options.timeBudgetMs !== undefined && Date.now() - startedAt > options.timeBudgetMs) {
        skipped += 1
        continue
      }
      results[index] = await fn(items[index])
      done += 1
      options.onProgress?.(done, items.length)
      await sleep(options.intervalMs)
    }
  }))
  return { results, skipped }
}
