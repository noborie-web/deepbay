// ユーザー要望(2026-10-12): 仕入先としてのAmazon、段階2。
// ASINを1件ずつ集めるのは手間なので、Amazonの検索URL(キーワード・カテゴリ)や
// キーワードからASIN一覧を作れるようにする。
//
// 重要な前提: SP-APIの searchCatalogItems は「Amazon.co.jpの検索結果」とは
// 別物で、並び順も件数も一致しない。サイトのスクレイピングはbot対策で
// 安定しないため、ここではSP-APIの検索を使い、画面でもその旨を明示する。
//
// 確認した仕様(searchCatalogItems, 2022-04-01):
//   - keywords は最大20語。identifiers とは併用できない
//   - brandNames / classificationIds は「キーワード検索の絞り込み」
//   - pageSize は最大20(既定10)、続きは pageToken
//   - レート制限は 2 req/s 想定。実際の値は x-amzn-RateLimit-Limit で返る
import { MARKETPLACE_JP, spapiFetch } from './amazon-spapi'

/** keywords に渡せる語数の上限(SP-APIの仕様) */
export const MAX_KEYWORDS = 20
/** 1ページの件数(SP-APIの上限) */
export const SEARCH_PAGE_SIZE = 20
/** レート制限の既定値(req/s)。応答ヘッダで分かればそちらを使う */
export const DEFAULT_SEARCH_RATE_PER_SEC = 2

export interface AmazonSearchQuery {
  keywords: string[]
  brandNames: string[]
  classificationIds: string[]
  /** 入力のうち検索に使えなかった条件(画面で伝える) */
  warnings: string[]
}

export interface AmazonSearchItem {
  asin: string
  title: string | null
  brand: string | null
}

export interface AmazonSearchResult {
  items: AmazonSearchItem[]
  /** 上限に達して打ち切った(続きがある) */
  truncated: boolean
  /** 実際に投げたリクエスト数(レート制限の確認用) */
  requests: number
}

export class AmazonSearchError extends Error {}

/**
 * Amazonの検索URL、または生のキーワードから検索条件を組み立てる。
 *
 * 対応するURLパラメータ:
 *   k        … 検索キーワード
 *   node     … カテゴリ(ブラウズノード) → classificationIds
 *   rh       … n:12345(カテゴリ) / p_89:ブランド名(ブランド絞り込み)
 *   i        … department(SP-APIに対応する指定が無いため無視し、警告を出す)
 */
export function parseAmazonSearchQuery(input: string): AmazonSearchQuery {
  const trimmed = input.trim()
  if (!trimmed) return { keywords: [], brandNames: [], classificationIds: [], warnings: [] }

  // URLそのものをキーワードとして検索しても意味が無いので、
  // Amazon以外のURLはキーワードにせず理由を返す
  if (/^https?:\/\//i.test(trimmed) && !toAmazonUrl(trimmed)) {
    return {
      keywords: [],
      brandNames: [],
      classificationIds: [],
      warnings: ['Amazon.co.jpの検索URLではありません。URLかキーワードを確認してください'],
    }
  }

  const url = toAmazonUrl(trimmed)
  if (!url) {
    return {
      keywords: splitKeywords(trimmed),
      brandNames: [],
      classificationIds: [],
      warnings: [],
    }
  }

  const params = url.searchParams
  const warnings: string[] = []
  const keywords = splitKeywords(params.get('k') ?? params.get('field-keywords') ?? '')
  const classificationIds = new Set<string>()
  const brandNames = new Set<string>()

  for (const node of (params.get('node') ?? '').split(',')) {
    const id = node.trim()
    if (/^\d+$/.test(id)) classificationIds.add(id)
  }

  // rh は "n:12345,p_89:SONY|CASIO" のような形式
  for (const clause of (params.get('rh') ?? '').split(',')) {
    const [rawKey, ...rest] = clause.split(':')
    const key = rawKey.trim()
    const value = rest.join(':').trim()
    if (!value) continue
    if (key === 'n') {
      for (const id of value.split('|')) {
        const trimmedId = id.trim().replace(/^!/, '')
        if (/^\d+$/.test(trimmedId)) classificationIds.add(trimmedId)
      }
    } else if (key === 'p_89') {
      for (const brand of value.split('|')) {
        const name = decodeURIComponent(brand.trim())
        if (name) brandNames.add(name)
      }
    }
  }

  const department = params.get('i')?.trim()
  if (department) {
    warnings.push(`URLの絞り込み「i=${department}」はSP-APIに対応する指定が無いため無視します`)
  }
  if (keywords.length === 0 && (classificationIds.size > 0 || brandNames.size > 0)) {
    warnings.push('SP-APIの検索はキーワードが必要です。カテゴリ・ブランドだけでは検索できないため、キーワードを足してください')
  }

  return {
    keywords,
    brandNames: Array.from(brandNames),
    classificationIds: Array.from(classificationIds),
    warnings,
  }
}

function toAmazonUrl(input: string): URL | null {
  if (!/^https?:\/\//i.test(input)) return null
  try {
    const url = new URL(input)
    // amazon.co.jp 以外(短縮URL等)はパラメータの意味が違うので扱わない
    if (!/(^|\.)amazon\.(co\.jp|com)$/i.test(url.hostname)) return null
    return url
  } catch {
    return null
  }
}

function splitKeywords(value: string): string[] {
  const words = value
    .replace(/\+/g, ' ')
    .split(/[\s,]+/)
    .map((word) => word.trim())
    .filter(Boolean)
  // 重複を除いてから上限で切る(同じ語を並べても絞り込みにならない)
  return Array.from(new Set(words)).slice(0, MAX_KEYWORDS)
}

/**
 * 検索条件からASIN一覧を取る。limit件に達するか、続きが無くなるまでページを送る。
 *
 * 既存ツールの教訓(2026-07-18)と同じ方針で、取れなかったものを
 * 「0件」として確定させない: 途中で失敗したらその時点までの結果と
 * truncated=true を返し、呼び出し側が「続きがある」と分かるようにする。
 */
export async function searchAmazonAsins(
  accessToken: string,
  query: AmazonSearchQuery,
  options: {
    limit?: number
    marketplaceId?: string
    signal?: AbortSignal
    timeoutMs?: number
    timeBudgetMs?: number
    /** テスト用: 待機の実装を差し替える */
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<AmazonSearchResult> {
  if (query.keywords.length === 0) {
    throw new AmazonSearchError('検索キーワードを入力してください（SP-APIの検索はキーワードが必要です）')
  }

  const limit = Math.max(1, Math.floor(options.limit ?? 100))
  const marketplaceId = options.marketplaceId ?? MARKETPLACE_JP
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const startedAt = Date.now()
  const budgetMs = options.timeBudgetMs ?? 60_000

  const items: AmazonSearchItem[] = []
  const seen = new Set<string>()
  let pageToken: string | null = null
  let requests = 0
  let ratePerSec = DEFAULT_SEARCH_RATE_PER_SEC

  for (;;) {
    if (items.length >= limit) return { items: items.slice(0, limit), truncated: true, requests }
    if (Date.now() - startedAt > budgetMs) return { items, truncated: true, requests }

    const params = new URLSearchParams({
      marketplaceIds: marketplaceId,
      includedData: 'summaries',
      pageSize: String(SEARCH_PAGE_SIZE),
      keywords: query.keywords.join(','),
    })
    if (query.brandNames.length > 0) params.set('brandNames', query.brandNames.join(','))
    if (query.classificationIds.length > 0) params.set('classificationIds', query.classificationIds.join(','))
    if (pageToken) params.set('pageToken', pageToken)

    const res = await spapiFetch(accessToken, `/catalog/2022-04-01/items?${params.toString()}`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    requests += 1

    // 実際のレート制限は応答ヘッダで分かる(既定の2 req/sと違うことがある)
    const headerRate = parseFloat(res.headers.get('x-amzn-RateLimit-Limit') ?? '')
    if (Number.isFinite(headerRate) && headerRate > 0) ratePerSec = headerRate

    if (!res.ok) {
      const detail = await readSpapiErrorMessage(res)
      // 1ページも取れていないなら失敗として投げる。取れている分は返す
      if (items.length === 0) throw new AmazonSearchError(`Amazonの検索に失敗しました: ${detail}`)
      return { items, truncated: true, requests }
    }

    const json = await res.json().catch(() => ({})) as {
      numberOfResults?: number
      pagination?: { nextToken?: string }
      items?: Array<{
        asin?: string
        summaries?: Array<{ itemName?: string; brand?: string; marketplaceId?: string }>
      }>
    }

    const page = json.items ?? []
    for (const item of page) {
      if (!item.asin || seen.has(item.asin)) continue
      seen.add(item.asin)
      const summary = item.summaries?.find((s) => s.marketplaceId === marketplaceId) ?? item.summaries?.[0]
      items.push({
        asin: item.asin,
        title: summary?.itemName?.trim() || null,
        brand: summary?.brand?.trim() || null,
      })
    }

    pageToken = json.pagination?.nextToken ?? null
    if (!pageToken || page.length === 0) {
      return { items: items.slice(0, limit), truncated: items.length > limit, requests }
    }
    // レート制限に当てないよう、次のページまで待つ
    await sleep(Math.ceil(1000 / ratePerSec))
  }
}

async function readSpapiErrorMessage(res: Response): Promise<string> {
  const json = await res.json().catch(() => null) as { errors?: Array<{ message?: string; code?: string }> } | null
  const first = json?.errors?.[0]
  return first?.message || first?.code || `HTTP ${res.status}`
}
