import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchWithRetry, mapThrottled } from '../lib/scrapers/throttled-fetch'

// 実データで確認した不具合: Yahoo!フリマの商品ページを並行8件で取得すると
// 429 Too Many Requests で拒否され、説明文・状態が空のまま登録された。
describe('fetchWithRetry', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); globalThis.fetch = originalFetch })

  const opts = { userAgent: 'ua', timeoutMs: 5000, intervalMs: 0, retries: 2, siteKey: 'test' }

  it('429のときは待って再試行し、成功したら本文を返す', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      return calls < 3
        ? new Response('slow down', { status: 429 })
        : new Response('<html>ok</html>', { status: 200 })
    }) as unknown as typeof fetch

    const promise = fetchWithRetry('https://example.com/item/1', opts)
    await vi.advanceTimersByTimeAsync(3000 + 6000)
    await expect(promise).resolves.toBe('<html>ok</html>')
    expect(calls).toBe(3)
  })

  it('404などの恒久的なエラーは再試行しない', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async () => { calls += 1; return new Response('', { status: 404, statusText: 'Not Found' }) }) as unknown as typeof fetch
    await expect(fetchWithRetry('https://example.com/item/1', opts)).rejects.toThrow('HTTP 404')
    expect(calls).toBe(1)
  })

  it('再試行回数を超えたら例外にする', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 429 })) as unknown as typeof fetch
    const promise = fetchWithRetry('https://example.com/item/1', opts)
    const assertion = expect(promise).rejects.toThrow('429')
    await vi.advanceTimersByTimeAsync(3000 + 6000 + 12000)
    await assertion
  })
})

describe('mapThrottled', () => {
  it('並行数を守り、間隔を置いて全件処理する', async () => {
    let active = 0
    let maxActive = 0
    const { results, skipped } = await mapThrottled([1, 2, 3, 4, 5], async (n) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(r => setTimeout(r, 10))
      active -= 1
      return n * 10
    }, { concurrency: 2, intervalMs: 5 })
    expect(results).toEqual([10, 20, 30, 40, 50])
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(skipped).toBe(0)
  })

  it('時間予算を超えたら残りは処理せず元の値のまま返す', async () => {
    const { results, skipped } = await mapThrottled([1, 2, 3, 4], async (n) => {
      await new Promise(r => setTimeout(r, 30))
      return n * 10
    }, { concurrency: 1, intervalMs: 0, timeBudgetMs: 40 })
    expect(results[0]).toBe(10)
    expect(results[3]).toBe(4)
    expect(skipped).toBeGreaterThan(0)
  })
})
