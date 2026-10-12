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
