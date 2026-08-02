import { describe, expect, it, vi } from 'vitest'
import {
  PRODUCT_SAVE_BATCH_SIZE,
  saveProductUpdatesInBatches,
} from '../lib/product-bulk-save'

function makeUpdates(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    productId: `p${index + 1}`,
    ebay_title: `Title ${index + 1}`,
  }))
}

describe('saveProductUpdatesInBatches', () => {
  it('287件を200件と87件に分割して全件保存する', async () => {
    const requestSizes: number[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { updates: Array<{ productId: string }> }
      requestSizes.push(body.updates.length)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          succeeded: body.updates.map((update) => update.productId),
          failed: [],
        }),
      } as Response
    })

    const result = await saveProductUpdatesInBatches(
      'ext-1',
      makeUpdates(287),
      fetcher as typeof fetch,
    )

    expect(PRODUCT_SAVE_BATCH_SIZE).toBe(200)
    expect(requestSizes).toEqual([200, 87])
    expect(result.succeeded).toHaveLength(287)
    expect(result.failed).toEqual([])
  })

  it('422の部分失敗を全バッチで集約する', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { updates: Array<{ productId: string }> }
      const failedItem = body.updates.at(-1)!
      return {
        ok: false,
        status: 422,
        json: async () => ({
          ok: false,
          succeeded: body.updates.slice(0, -1).map((update) => update.productId),
          failed: [{ productId: failedItem.productId, error: 'validation error' }],
        }),
      } as Response
    })

    const result = await saveProductUpdatesInBatches(
      'ext-1',
      makeUpdates(205),
      fetcher as typeof fetch,
    )

    expect(result.succeeded).toHaveLength(203)
    expect(result.failed).toEqual([
      { productId: 'p200', error: 'validation error' },
      { productId: 'p205', error: 'validation error' },
    ])
  })

  it('通信失敗時は未送信分を編集状態として残せる結果を返す', async () => {
    let requestCount = 0
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1
      const body = JSON.parse(String(init?.body)) as { updates: Array<{ productId: string }> }
      if (requestCount === 2) throw new Error('Network error')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          succeeded: body.updates.map((update) => update.productId),
          failed: [],
        }),
      } as Response
    })

    const result = await saveProductUpdatesInBatches(
      'ext-1',
      makeUpdates(287),
      fetcher as typeof fetch,
    )

    expect(result.succeeded).toHaveLength(200)
    expect(result.failed).toHaveLength(87)
    expect(result.failed[0]).toEqual({
      productId: 'p201',
      error: '通信エラー: Network error',
    })
  })
})
