// メルカリのAPI(api.mercari.jp)に必要なヘッダとDPoP署名。
//
// 通常のメルカリ検索(mercari.ts)とメルカリShopsの商品詳細
// (mercari_shops.ts)の両方から使うため、どちらにも属さない場所に置く
// (mercari.ts は mercari_shops.ts を import しているので、逆向きの
//  import を足すと循環参照になる)。

export const MERCARI_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Origin': 'https://jp.mercari.com',
  'Referer': 'https://jp.mercari.com/',
  'X-Platform': 'web',
}

function base64url(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64urlStr(str: string): string {
  return base64url(new TextEncoder().encode(str))
}

export interface DPoPContext {
  keyPair: CryptoKeyPair
  publicJwk: JsonWebKey
  uuid: string
}

let _dpopCtx: DPoPContext | null = null

export async function getDPoPContext(): Promise<DPoPContext> {
  if (!_dpopCtx) {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign'],
    )
    const full = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const publicJwk: JsonWebKey = { crv: full.crv, kty: full.kty, x: full.x, y: full.y }
    _dpopCtx = { keyPair, publicJwk, uuid: crypto.randomUUID() }
  }
  return _dpopCtx
}

export async function generateDPoP(htu: string, htm: string, ctx: DPoPContext): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: ctx.publicJwk }
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID().replace(/-/g, ''),
    htu,
    htm,
    uuid: ctx.uuid,
  }
  const signingInput = `${base64urlStr(JSON.stringify(header))}.${base64urlStr(JSON.stringify(payload))}`
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    ctx.keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64url(new Uint8Array(sig))}`
}

/** DPoP署名を付けてメルカリのAPIを呼ぶ。 */
export async function mercariApiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const dpop = await generateDPoP(url, method, await getDPoPContext())
  return fetch(url, {
    ...init,
    headers: { ...MERCARI_API_HEADERS, ...(init.headers as Record<string, string> | undefined), 'DPoP': dpop },
  })
}
