import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchEbayRateLimits, rateLimitFor, resetEbayRateLimitCache } from '@/lib/ebay-rate-limits'

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

  it('環境変数が無ければその旨を伝える', async () => {
    delete process.env.EBAY_CLIENT_ID
    await expect(fetchEbayRateLimits()).rejects.toThrow(/EBAY_CLIENT_ID/)
  })
})
