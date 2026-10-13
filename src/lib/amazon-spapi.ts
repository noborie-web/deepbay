// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
// Amazonはbot対策が強く、Vercelのデータセンター回線からのスクレイピングは
// 安定しないため、SP-APIを使う。
//
// 既存のPythonツール(spapi_prima_bulk_fast_real.py)で実測した制限値:
//   getCatalogItem      2.0 req/s
//   getItemOffers(単体)  0.5 req/s
//   getItemOffersBatch  0.1 req/s (1回20 ASIN = 実効2 ASIN/s)
// 律速は価格のバッチ側なので、カタログ取得はその待ち時間に並行させる。

/** 日本のマーケットプレイス */
export const MARKETPLACE_JP = 'A1VC38T7YXB528'

/** SP-APIのエンドポイント(極東リージョン) */
export const SPAPI_ENDPOINT = 'https://sellingpartnerapi-fe.amazon.com'

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

export interface AmazonCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export class AmazonAuthError extends Error {}

/**
 * LWAのアクセストークンを取得する。認証情報が正しいかの確認にも使う
 * (保存時にこれを呼んで、通らない情報を保存しない)。
 */
export async function fetchAccessToken(
  credentials: AmazonCredentials,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ accessToken: string; expiresInSec: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Amazon認証がタイムアウトしました')), options.timeoutMs ?? 15_000)
  options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true })

  try {
    const res = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
      signal: controller.signal,
    })

    const json = await res.json().catch(() => ({})) as {
      access_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }

    if (!res.ok || !json.access_token) {
      // Amazonは理由を error / error_description で返す
      // (invalid_grant = リフレッシュトークンが失効/不一致、invalid_client = ID/Secret不一致)
      const reason = json.error_description || json.error || `HTTP ${res.status}`
      throw new AmazonAuthError(`Amazonの認証に失敗しました: ${reason}`)
    }

    return { accessToken: json.access_token, expiresInSec: json.expires_in ?? 3600 }
  } catch (error) {
    if (error instanceof AmazonAuthError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new AmazonAuthError(`Amazonの認証に失敗しました: ${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

/** ASINの形式(10桁の英数字)。入力の取り違えを早めに弾く。 */
const ASIN_RE = /^[A-Z0-9]{10}$/

export function isAsin(value: string): boolean {
  return ASIN_RE.test(value.trim().toUpperCase())
}

/**
 * 貼り付け・CSVの入力からASINを取り出す。
 * 改行・カンマ・タブ・空白区切りを受け付け、重複は除く
 * (既存ツールでは入力175,957行のうち39%が重複だった)。
 */
export function parseAsinInput(input: string): { asins: string[]; invalid: string[] } {
  const tokens = input
    .split(/[\s,"']+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean)

  const asins: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    // Amazonの商品URLから拾えるようにする(/dp/ASIN, /gp/product/ASIN)
    const fromUrl = token.match(/(?:\/DP\/|\/GP\/PRODUCT\/|\/ASIN\/)([A-Z0-9]{10})/)?.[1]
    const candidate = fromUrl ?? token
    if (!isAsin(candidate)) {
      // ヘッダー行(asin等)は無視し、それ以外は不正として返す
      if (!/^ASIN$/i.test(candidate)) invalid.push(token)
      continue
    }
    if (seen.has(candidate)) continue
    seen.add(candidate)
    asins.push(candidate)
  }
  return { asins, invalid }
}

// ---------------------------------------------------------------------------
// カタログ・価格の取得
// ---------------------------------------------------------------------------

/** 1リクエストで扱えるASIN数(SP-APIの上限) */
export const BATCH_SIZE = 20

export interface AmazonCatalogItem {
  asin: string
  title: string | null
  brand: string | null
  imageUrls: string[]
}

interface CatalogImage { link?: string; height?: number; width?: number }

/**
 * カタログ情報を最大20件まとめて取る。
 * 既存ツールは getCatalogItem を1件ずつ(2.0 req/s)呼んでいたが、
 * searchCatalogItems の identifiers なら20件を1リクエストで取れる。
 */
export async function fetchCatalogItems(
  accessToken: string,
  asins: string[],
  options: { marketplaceId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Map<string, AmazonCatalogItem>> {
  const result = new Map<string, AmazonCatalogItem>()
  if (asins.length === 0) return result

  const marketplaceId = options.marketplaceId ?? MARKETPLACE_JP
  const params = new URLSearchParams({
    identifiers: asins.join(','),
    identifiersType: 'ASIN',
    marketplaceIds: marketplaceId,
    includedData: 'summaries,images',
  })
  const res = await spapiFetch(
    accessToken,
    `/catalog/2022-04-01/items?${params.toString()}`,
    { signal: options.signal, timeoutMs: options.timeoutMs },
  )
  const json = await res.json().catch(() => ({})) as {
    items?: Array<{
      asin?: string
      summaries?: Array<{ itemName?: string; brand?: string; marketplaceId?: string }>
      images?: Array<{ marketplaceId?: string; images?: CatalogImage[] }>
    }>
  }

  for (const item of json.items ?? []) {
    if (!item.asin) continue
    const summary = item.summaries?.find((s) => s.marketplaceId === marketplaceId) ?? item.summaries?.[0]
    const imageGroup = item.images?.find((g) => g.marketplaceId === marketplaceId) ?? item.images?.[0]
    // 同じ写真が複数サイズで返るので、大きい順に見て重複を除く
    const seen = new Set<string>()
    const imageUrls: string[] = []
    for (const image of (imageGroup?.images ?? []).slice().sort((a, b) => (b.height ?? 0) - (a.height ?? 0))) {
      const link = image.link
      if (!link) continue
      const key = link.replace(/\._[^.]+(?=\.jpg$)/i, '')
      if (seen.has(key)) continue
      seen.add(key)
      imageUrls.push(link)
    }
    result.set(item.asin, {
      asin: item.asin,
      title: summary?.itemName?.trim() || null,
      brand: summary?.brand?.trim() || null,
      imageUrls,
    })
  }
  return result
}

export interface OffersFetchResult {
  /** 取得できたASINごとのペイロード */
  payloads: Map<string, unknown>
  /** 取得できなかったASIN。価格0で確定させず、次回に回す */
  failed: string[]
}

/**
 * 価格(オファー)を最大20件まとめて取る。
 *
 * 既存ツールで起きた重大な不具合(2026-07-18)の再発防止:
 * バッチが失敗したとき空の結果を返すと、呼び出し側が20件まとめて「価格0」として
 * 確定保存してしまい、17.6万件中2万件(11%)が壊れた。失敗したASINは必ず
 * failed に入れ、価格0として扱わない。
 */
export async function fetchItemOffersBatch(
  accessToken: string,
  asins: string[],
  options: { marketplaceId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OffersFetchResult> {
  const payloads = new Map<string, unknown>()
  if (asins.length === 0) return { payloads, failed: [] }

  const marketplaceId = options.marketplaceId ?? MARKETPLACE_JP
  const body = {
    requests: asins.map((asin) => ({
      uri: `/products/pricing/v0/items/${asin}/offers`,
      method: 'GET',
      MarketplaceId: marketplaceId,
      ItemCondition: 'New',
      CustomerType: 'Consumer',
    })),
  }

  let res: Response
  try {
    res = await spapiFetch(accessToken, '/batches/products/pricing/v0/itemOffers', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  } catch {
    return { payloads, failed: [...asins] }
  }
  if (!res.ok) return { payloads, failed: [...asins] }

  const json = await res.json().catch(() => ({})) as {
    responses?: Array<{
      status?: { statusCode?: number }
      request?: { uri?: string }
      body?: { payload?: { ASIN?: string } }
    }>
  }

  const responses = json.responses ?? []
  responses.forEach((entry, index) => {
    const payload = entry.body?.payload
    const fromUri = entry.request?.uri?.match(/\/items\/([A-Za-z0-9]{10})\/offers/)?.[1]
    const asin = payload?.ASIN ?? fromUri ?? asins[index]
    if (asin && entry.status?.statusCode === 200 && payload) payloads.set(asin, payload)
  })

  const failed = asins.filter((asin) => !payloads.has(asin))
  return { payloads, failed }
}

async function spapiFetch(
  accessToken: string,
  path: string,
  options: { method?: string; body?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Amazon SP-APIがタイムアウトしました')), options.timeoutMs ?? 20_000)
  options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true })
  try {
    return await fetch(`${SPAPI_ENDPOINT}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: options.body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}
