import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const EBAY_DEFAULT_MARKETPLACE = 'EBAY_US'
export const EBAY_OAUTH_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
] as const

export interface EbayPolicyOption {
  id: string
  name: string
  marketplaceId: string
  categoryTypes: string[]
}

export interface EbayPolicySet {
  marketplaceId: string
  fulfillment: EbayPolicyOption[]
  payment: EbayPolicyOption[]
  return: EbayPolicyOption[]
  syncedAt: string
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface IdentityResponse {
  userId?: string
  username?: string
  registrationMarketplaceId?: string
}

interface RawPolicy {
  name?: unknown
  marketplaceId?: unknown
  categoryTypes?: Array<{ name?: unknown }>
  fulfillmentPolicyId?: unknown
  paymentPolicyId?: unknown
  returnPolicyId?: unknown
}

function getEbayCredentials() {
  const clientId = (process.env.EBAY_CLIENT_ID ?? '').trim()
  const clientSecret = (process.env.EBAY_CLIENT_SECRET ?? '').trim()
  const redirectUriName = (process.env.EBAY_REDIRECT_URI_NAME ?? '').trim()
  if (!clientId || !clientSecret || !redirectUriName) {
    const missing = [
      !clientId && 'EBAY_CLIENT_ID',
      !clientSecret && 'EBAY_CLIENT_SECRET',
      !redirectUriName && 'EBAY_REDIRECT_URI_NAME',
    ].filter(Boolean)
    throw new Error(`eBay OAuth環境変数が未設定です: ${missing.join(', ')}`)
  }
  return { clientId, clientSecret, redirectUriName }
}

function getEncryptionKey(): Buffer {
  const raw = (process.env.EBAY_TOKEN_ENCRYPTION_KEY ?? '').trim()
  if (!raw) throw new Error('EBAY_TOKEN_ENCRYPTION_KEY が未設定です')

  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('EBAY_TOKEN_ENCRYPTION_KEY は32バイトのBase64値にしてください')
  }
  return key
}

export function encryptEbayRefreshToken(token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptEbayRefreshToken(encrypted: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = encrypted.split('.')
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('保存済みeBay認証情報の形式が不正です')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivValue, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const { clientId, clientSecret } = getEbayCredentials()
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthorization(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    cache: 'no-store',
  })
  const payload = await response.json() as TokenResponse
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `eBay OAuth error: ${response.status}`)
  }
  return payload
}

export function buildEbayConsentUrl(state: string): string {
  const { clientId, redirectUriName } = getEbayCredentials()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriName,
    response_type: 'code',
    scope: EBAY_OAUTH_SCOPES.join(' '),
    state,
    locale: 'ja-JP',
  })
  return `https://auth.ebay.com/oauth2/authorize?${params.toString()}`
}

export async function exchangeEbayAuthorizationCode(code: string): Promise<TokenResponse> {
  const { redirectUriName } = getEbayCredentials()
  return requestToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUriName,
  }))
}

export async function refreshEbayAccessToken(refreshToken: string): Promise<string> {
  const payload = await requestToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: EBAY_OAUTH_SCOPES.join(' '),
  }))
  return payload.access_token!
}

export async function getEbayIdentity(accessToken: string): Promise<Required<Pick<IdentityResponse, 'userId'>> & IdentityResponse> {
  const response = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
  const payload = await response.json() as IdentityResponse & { errors?: Array<{ message?: string }> }
  if (!response.ok || !payload.userId) {
    throw new Error(payload.errors?.[0]?.message || `eBay Identity API error: ${response.status}`)
  }
  return payload as Required<Pick<IdentityResponse, 'userId'>> & IdentityResponse
}

function normalizePolicies(
  policies: RawPolicy[],
  idKey: 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId',
): EbayPolicyOption[] {
  return policies.flatMap((policy) => {
    const id = policy[idKey]
    if (typeof id !== 'string' || typeof policy.name !== 'string') return []
    return [{
      id,
      name: policy.name,
      marketplaceId: typeof policy.marketplaceId === 'string'
        ? policy.marketplaceId
        : EBAY_DEFAULT_MARKETPLACE,
      categoryTypes: (policy.categoryTypes ?? [])
        .map((categoryType) => categoryType.name)
        .filter((name): name is string => typeof name === 'string'),
    }]
  })
}

async function fetchPolicyResource(
  accessToken: string,
  resource: 'fulfillment_policy' | 'payment_policy' | 'return_policy',
  marketplaceId: string,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ marketplace_id: marketplaceId })
  const response = await fetch(
    `https://api.ebay.com/sell/account/v1/${resource}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Language': 'en-US',
      },
      cache: 'no-store',
    },
  )
  const payload = await response.json() as Record<string, unknown> & {
    errors?: Array<{ message?: string; longMessage?: string }>
  }
  if (!response.ok) {
    const error = payload.errors?.[0]
    throw new Error(error?.longMessage || error?.message || `eBay Account API error: ${response.status}`)
  }
  return payload
}

export async function fetchEbayPolicies(
  accessToken: string,
  marketplaceId = EBAY_DEFAULT_MARKETPLACE,
): Promise<EbayPolicySet> {
  const [fulfillmentPayload, paymentPayload, returnPayload] = await Promise.all([
    fetchPolicyResource(accessToken, 'fulfillment_policy', marketplaceId),
    fetchPolicyResource(accessToken, 'payment_policy', marketplaceId),
    fetchPolicyResource(accessToken, 'return_policy', marketplaceId),
  ])
  return {
    marketplaceId,
    fulfillment: normalizePolicies(
      (fulfillmentPayload.fulfillmentPolicies as RawPolicy[] | undefined) ?? [],
      'fulfillmentPolicyId',
    ),
    payment: normalizePolicies(
      (paymentPayload.paymentPolicies as RawPolicy[] | undefined) ?? [],
      'paymentPolicyId',
    ),
    return: normalizePolicies(
      (returnPayload.returnPolicies as RawPolicy[] | undefined) ?? [],
      'returnPolicyId',
    ),
    syncedAt: new Date().toISOString(),
  }
}
