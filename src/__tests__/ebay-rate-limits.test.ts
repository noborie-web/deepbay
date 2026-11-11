import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchEbayRateLimits, fetchEbayUserRateLimits, rateLimitFor, resetEbayRateLimitCache } from '@/lib/ebay-rate-limits'

// 本番で確認した不具合(2026-11-08〜09): 同期が「exceeded usage limit on this
// call」で失敗していた。11/7は GetItem 3,857回で正常、11/8は 2,238回で拒否。
// Kakehashiが数えていた「太平洋時間の暦日あたりの回数」では説明がつかず、
// 上限値も時間の区切りも推測だった。
// GetApiAccessRules の後継(Developer Analytics API の getRateLimits)から、
// eBay自身が持つ上限・残り・時間窓を取る。

const TOKEN = { access_token: 'app-token', expires_in: 7200 }

function rateLimitsBody() {
  return {
    rateLimits: [{
      apiContext: 'trading',
      apiName: 'Trading',
      apiVersion: 'v1',
      resources: [
        { name: 'GetItem', rates: [{ count: 2238, limit: 5000, remaining: 2762, reset: '2026-11-09T08:00:00.000Z', timeWindow: 86400 }] },
        { name: 'ReviseInventoryStatus', rates: [{ count: 482, limit: 3000, remaining: 2518, reset: '2026-11-09T08:00:00.000Z', timeWindow: 86400 }] },
        // 上限が返らない資源は枠の管理に使えない
        { name: 'GetSellerList', rates: [{ count: 11 }] },
      ],
    }],
  }
}

function mockFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  let next = 0
  return vi.fn(async () => {
    const r = responses[Math.min(next++, responses.length - 1)]
    const status = r.status ?? 200
    if (r.json !== undefined) {
      return new Response(JSON.stringify(r.json), { status, headers: { 'Content-Type': 'application/json' } })
    }
    // 204 は本文を持てない(Responseの仕様)
    return new Response(status === 204 ? null : (r.text ?? ''), { status })
  })
}

describe('eBayの呼び出し枠を取る', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    resetEbayRateLimitCache()
    process.env.EBAY_CLIENT_ID = 'id'
    process.env.EBAY_CLIENT_SECRET = 'secret'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

  it('呼び出しごとの上限・残り・時間窓を読む', async () => {
    globalThis.fetch = mockFetch([{ json: TOKEN }, { json: rateLimitsBody() }]) as unknown as typeof fetch

    const limits = await fetchEbayRateLimits()
    const getItem = rateLimitFor(limits, 'GetItem')

    expect(getItem).toMatchObject({
      name: 'GetItem', limit: 5000, remaining: 2762, count: 2238, timeWindowSeconds: 86400,
    })
    // ここが本題。時間窓が分かるので、暦日で数える前提が正しいか判断できる
    expect(getItem!.reset).toBe('2026-11-09T08:00:00.000Z')
    expect(getItem!.apiContext).toBe('trading')
  })

  it('上限が返らない資源は持たない(枠の管理に使えないため)', async () => {
    globalThis.fetch = mockFetch([{ json: TOKEN }, { json: rateLimitsBody() }]) as unknown as typeof fetch

    const limits = await fetchEbayRateLimits()
    expect(rateLimitFor(limits, 'GetSellerList')).toBeNull()
    expect(rateLimitFor(limits, 'ReviseInventoryStatus')?.remaining).toBe(2518)
  })

  it('同じ呼び出しが複数の時間窓で返ったら、厳しい方を使う', async () => {
    const body = {
      rateLimits: [{
        apiContext: 'trading',
        resources: [{
          name: 'GetItem',
          rates: [
            { limit: 5000, remaining: 2762, count: 2238, timeWindow: 86400 },
            // 1時間あたりの枠が先に尽きることがある
            { limit: 500, remaining: 12, count: 488, timeWindow: 3600 },
          ],
        }],
      }],
    }
    globalThis.fetch = mockFetch([{ json: TOKEN }, { json: body }]) as unknown as typeof fetch

    expect(rateLimitFor(await fetchEbayRateLimits(), 'GetItem')).toMatchObject({
      remaining: 12, timeWindowSeconds: 3600,
    })
  })

  it('枠のデータが無い(204)ときは空で返す', async () => {
    globalThis.fetch = mockFetch([{ json: TOKEN }, { status: 204 }]) as unknown as typeof fetch
    expect(await fetchEbayRateLimits()).toEqual([])
  })

  it('取得に失敗したら握りつぶさず投げる', async () => {
    globalThis.fetch = mockFetch([{ json: TOKEN }, { status: 500, text: 'boom' }]) as unknown as typeof fetch
    await expect(fetchEbayRateLimits()).rejects.toThrow(/500/)
  })

  it('短時間に何度も取りに行かない(枠を無駄に使わない)', async () => {
    const fetchMock = mockFetch([{ json: TOKEN }, { json: rateLimitsBody() }])
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchEbayRateLimits()
    await fetchEbayRateLimits()
    // トークン取得1回 + 枠取得1回のまま
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // ユーザー報告(2026-11-11): 「unauthorized」とだけ返り、Kakehashiの未ログインか
  // eBayの拒否かが区別できなかった。
  it('トークン取得を拒否されたら、送り先と応答をそのまま伝える', async () => {
    globalThis.fetch = mockFetch([
      { status: 401, json: { error: 'invalid_client', error_description: 'client authentication failed' } },
    ]) as unknown as typeof fetch

    await expect(fetchEbayRateLimits()).rejects.toThrow(
      /アプリ用トークンを取得できませんでした \(HTTP 401\): client authentication failed/,
    )
  })

  it('JSONで返らない拒否でも中身を伝える', async () => {
    globalThis.fetch = mockFetch([{ status: 403, text: 'Forbidden by gateway' }]) as unknown as typeof fetch
    await expect(fetchEbayRateLimits()).rejects.toThrow(/HTTP 403.*Forbidden by gateway/)
  })

  it('環境変数が無ければその旨を伝える', async () => {
    delete process.env.EBAY_CLIENT_ID
    await expect(fetchEbayRateLimits()).rejects.toThrow(/EBAY_CLIENT_ID/)
  })
})

// 本番で確認した不具合(2026-11-11): アプリ全体の枠(getRateLimits)はTrading APIの
// どの呼び出しも limit 5,000 / count 0 を返していた。毎日数千回呼んでいるのに
// 0ということは、Trading APIの枠は「ユーザー単位」で数えられているということ。
describe('セラーごとの呼び出し枠', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

  it('セラーのトークンで取り、アプリ用トークンは使わない', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer seller-token')
      return new Response(JSON.stringify({
        rateLimits: [{
          apiContext: 'TradingAPI',
          resources: [{ name: 'GetItem', rates: [{ limit: 5000, remaining: 1200, count: 3800, timeWindow: 86400 }] }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const limits = await fetchEbayUserRateLimits('seller-token')
    expect(rateLimitFor(limits, 'GetItem')).toMatchObject({ limit: 5000, remaining: 1200, count: 3800 })
    // トークン取得(client credentials)は呼ばない
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('スコープ不足なら、接続し直す必要があることまで伝える', async () => {
    globalThis.fetch = vi.fn(async () => new Response('insufficient permissions', { status: 403 })) as unknown as typeof fetch
    await expect(fetchEbayUserRateLimits('seller-token')).rejects.toThrow(/接続し直して/)
  })

  it('枠のデータが無い(204)ときは空で返す', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    expect(await fetchEbayUserRateLimits('seller-token')).toEqual([])
  })
})
