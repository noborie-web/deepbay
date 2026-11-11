// ---------------------------------------------------------------------------
// eBayが持っている本当の呼び出し枠を取る。
//
// 本番で確認した不具合(2026-11-08〜09): 同期が
// 「Your application has exceeded usage limit on this call」で失敗していた。
//   11/07  GetItem 3,857回  正常
//   11/08  GetItem 2,238回  失敗
// 前日より少ない回数で拒否されており、Kakehashiが数えている「太平洋時間の
// 暦日あたりの合計」では説明がつかなかった。上限値も時間の区切りも推測で
// 置いていたため、どう調整しても当て推量にしかならない。
//
// GetApiAccessRules は2023-03-10に廃止されたが、後継として
// Developer Analytics API の getRateLimits がある。呼び出しごとの
// 上限・使用済み・残り・リセット時刻・時間窓(秒)を返す。
//   GET https://api.ebay.com/developer/analytics/v1_beta/rate_limit/
//   認証: client credentials grant (scope https://api.ebay.com/oauth/api_scope)
// ---------------------------------------------------------------------------

const RATE_LIMIT_URL = 'https://api.ebay.com/developer/analytics/v1_beta/rate_limit/'
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token'
const APP_SCOPE = 'https://api.ebay.com/oauth/api_scope'
// 呼び出し枠の取得そのものも枠を使うので、短時間に何度も取りに行かない
const CACHE_TTL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000

/** 1つの呼び出し(例: GetItem)の枠 */
export interface EbayRateLimit {
  /** 呼び出し名。Trading APIなら GetItem / ReviseInventoryStatus など */
  name: string
  /** この時間窓で送ってよい上限 */
  limit: number
  /** 残り */
  remaining: number
  /** この時間窓で送った回数 */
  count: number
  /** 枠が戻る時刻(eBayが返す文字列をそのまま持つ) */
  reset: string | null
  /** 時間窓の長さ(秒)。86400なら1日、3600なら1時間 */
  timeWindowSeconds: number | null
  /** どのAPIのものか(trading / sell など) */
  apiContext: string | null
  apiName: string | null
}

interface RateJson {
  count?: number
  limit?: number
  remaining?: number
  reset?: string
  timeWindow?: number
}
interface ResourceJson { name?: string; rates?: RateJson[] }
interface RateLimitJson {
  apiContext?: string
  apiName?: string
  apiVersion?: string
  resources?: ResourceJson[]
}
interface RateLimitsResponseJson { rateLimits?: RateLimitJson[] }

let cached: { at: number; limits: EbayRateLimit[] } | null = null
let cachedToken: { at: number; expiresInMs: number; token: string } | null = null

/** テスト用。取り込んだキャッシュを捨てる */
export function resetEbayRateLimitCache(): void {
  cached = null
  cachedToken = null
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = (process.env.EBAY_CLIENT_ID ?? '').trim()
  const clientSecret = (process.env.EBAY_CLIENT_SECRET ?? '').trim()
  if (!clientId || !clientSecret) {
    throw new Error('eBay OAuth環境変数が未設定です: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET')
  }
  return { clientId, clientSecret }
}

/**
 * アプリ用のアクセストークン(client credentials grant)。
 * 出品セラーのトークンとは別物で、アプリ全体の枠を見るのに使う。
 */
async function applicationToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.at < cachedToken.expiresInMs) return cachedToken.token
  const { clientId, clientSecret } = credentials()
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: APP_SCOPE }).toString(),
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await response.text()
  let payload: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {}
  try { payload = JSON.parse(raw) } catch { /* JSONでない応答もそのまま見せる */ }
  if (!response.ok || !payload.access_token) {
    // ユーザー報告(2026-11-11): 「unauthorized」とだけ返り、Kakehashiの
    // 未ログインなのかeBayの拒否なのか区別が付かなかった。どちらで何が
    // 起きたのかが分かるように、送り先と応答をそのまま含める。
    const detail = payload.error_description || payload.error || raw.slice(0, 300) || '(応答なし)'
    throw new Error(`eBayのアプリ用トークンを取得できませんでした (HTTP ${response.status}): ${detail}`)
  }
  // 期限ぎりぎりまで使い回すと失敗するので、1分手前で取り直す
  const expiresInMs = Math.max(60_000, (payload.expires_in ?? 7200) * 1000 - 60_000)
  cachedToken = { at: Date.now(), expiresInMs, token: payload.access_token }
  return payload.access_token
}

function parseRateLimits(json: RateLimitsResponseJson): EbayRateLimit[] {
  const limits: EbayRateLimit[] = []
  for (const api of json.rateLimits ?? []) {
    for (const resource of api.resources ?? []) {
      const name = resource.name?.trim()
      if (!name) continue
      for (const rate of resource.rates ?? []) {
        // 上限が無い(null)資源は枠の管理に使えないので持たない
        if (typeof rate.limit !== 'number') continue
        limits.push({
          name,
          limit: rate.limit,
          remaining: typeof rate.remaining === 'number' ? rate.remaining : rate.limit,
          count: typeof rate.count === 'number' ? rate.count : 0,
          reset: rate.reset ?? null,
          timeWindowSeconds: typeof rate.timeWindow === 'number' ? rate.timeWindow : null,
          apiContext: api.apiContext ?? null,
          apiName: api.apiName ?? null,
        })
      }
    }
  }
  return limits
}

/**
 * eBayから呼び出し枠を取る。失敗したら例外。
 * 同じプロセス内では CACHE_TTL_MS の間だけ使い回す。
 */
export async function fetchEbayRateLimits(options: { force?: boolean } = {}): Promise<EbayRateLimit[]> {
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.limits

  const token = await applicationToken()
  const response = await fetch(RATE_LIMIT_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // 枠のデータがまだ無いときは 204 が返る(eBayの既知の挙動)
  if (response.status === 204) {
    cached = { at: Date.now(), limits: [] }
    return []
  }
  if (!response.ok) {
    throw new Error(`eBay rate limit error: ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  const limits = parseRateLimits(await response.json() as RateLimitsResponseJson)
  cached = { at: Date.now(), limits }
  return limits
}

/**
 * 呼び出し名(GetItem など)の枠を探す。
 * 同じ名前が複数の時間窓で返ることがあるので、いちばん厳しいものを返す。
 */
export function rateLimitFor(limits: EbayRateLimit[], callName: string): EbayRateLimit | null {
  const matched = limits.filter(limit => limit.name === callName)
  if (matched.length === 0) return null
  return matched.reduce((strictest, limit) => (limit.remaining < strictest.remaining ? limit : strictest))
}
