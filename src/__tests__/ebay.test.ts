import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildEbayConsentUrl,
  decryptEbayRefreshToken,
  encryptEbayRefreshToken,
  fetchEbayPolicies,
  refreshEbayAccessToken,
} from '@/lib/ebay'

beforeEach(() => {
  vi.stubEnv('EBAY_CLIENT_ID', 'client-id')
  vi.stubEnv('EBAY_CLIENT_SECRET', 'client-secret')
  vi.stubEnv('EBAY_REDIRECT_URI_NAME', 'example-app-runame')
  vi.stubEnv('EBAY_TOKEN_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('eBay OAuth helpers', () => {
  it('更新トークンをAES-GCMで暗号化して復号できる', () => {
    const encrypted = encryptEbayRefreshToken('refresh-token-value')
    expect(encrypted).not.toContain('refresh-token-value')
    expect(encrypted.startsWith('v1.')).toBe(true)
    expect(decryptEbayRefreshToken(encrypted)).toBe('refresh-token-value')
  })

  it('改ざんされた暗号文は復号できない', () => {
    const encrypted = encryptEbayRefreshToken('refresh-token-value')
    const segments = encrypted.split('.')
    const ciphertext = Buffer.from(segments[3], 'base64url')
    ciphertext[0] ^= 1
    segments[3] = ciphertext.toString('base64url')
    const tampered = segments.join('.')
    expect(() => decryptEbayRefreshToken(tampered)).toThrow()
  })

  it('同意URLに読み取り専用Accountスコープとstateを含める', () => {
    const url = new URL(buildEbayConsentUrl('state-123'))
    expect(url.origin).toBe('https://auth.ebay.com')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('example-app-runame')
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('scope')).toContain('/commerce.identity.readonly')
    expect(url.searchParams.get('scope')).toContain('/sell.account.readonly')
  })
})

describe('eBay policy sync', () => {
  it('配送・支払・返品ポリシーを選択肢へ正規化する', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/fulfillment_policy?')) {
        return new Response(JSON.stringify({
          fulfillmentPolicies: [{
            fulfillmentPolicyId: 'f1',
            name: 'Worldwide Shipping',
            marketplaceId: 'EBAY_US',
            categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
          }],
        }), { status: 200 })
      }
      if (url.includes('/payment_policy?')) {
        return new Response(JSON.stringify({
          paymentPolicies: [{
            paymentPolicyId: 'p1',
            name: 'eBay Payments',
            marketplaceId: 'EBAY_US',
          }],
        }), { status: 200 })
      }
      if (url.includes('/return_policy?')) {
        return new Response(JSON.stringify({
          returnPolicies: [{
            returnPolicyId: 'r1',
            name: 'Returns 60 Days',
            marketplaceId: 'EBAY_US',
          }],
        }), { status: 200 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch

    const policies = await fetchEbayPolicies('access-token', 'EBAY_US')
    expect(policies.fulfillment).toEqual([{
      id: 'f1',
      name: 'Worldwide Shipping',
      marketplaceId: 'EBAY_US',
      categoryTypes: ['ALL_EXCLUDING_MOTORS_VEHICLES'],
    }])
    expect(policies.payment[0]?.name).toBe('eBay Payments')
    expect(policies.return[0]?.name).toBe('Returns 60 Days')
  })
})

// 本番で確認した不具合(2026-11-11): miyabi-24 のトークン更新が
// 「The requested scope is invalid, unknown, malformed, or exceeds the scope
// granted to the client」で失敗し、同期・価格改定・取り下げの対象から外れて
// いた。しかも対象セラーは一覧から黙って消えるため気づけなかった。
//
// 原因は、更新時に「いまKakehashiが要求するスコープ一覧」をそのまま送っていた
// こと。許可を取った後にスコープを足すと、古い許可のトークンは更新できない。
describe('アクセストークンの更新', () => {
  it('scope を送らない(スコープを足しても既存のセラーが壊れない)', async () => {
    let sentBody = ''
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ access_token: 'new-token' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    expect(await refreshEbayAccessToken('refresh-token')).toBe('new-token')

    const params = new URLSearchParams(sentBody)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('refresh-token')
    // ここが本題。送ると、許可済みの範囲を超えたときに更新ごと失敗する
    expect(params.has('scope')).toBe(false)
  })

  it('更新に失敗したら理由を投げる', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch

    await expect(refreshEbayAccessToken('refresh-token')).rejects.toThrow('refresh token expired')
  })
})
