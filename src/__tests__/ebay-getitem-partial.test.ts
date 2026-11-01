import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchListingsByItemIds } from '@/lib/ebay-inventory'

// 本番で確認した不具合(2026-11-01): miyabi-24 は #328 で一覧取得をやめて個別照会に
// 切り替わったが、618件を60秒で引き切れずに時間切れとなり、例外が同期全体を
// 落としていた。取得できていた分まで捨てられ、実行記録も残らなかった
// (result_summary が空のまま failed)。
// 一覧取得(#327)と同じく、取れたところまでで返して続きは次回に回す。

function itemResponse(itemId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <ItemID>${itemId}</ItemID>
    <Title>Item ${itemId}</Title>
    <SKU>kakehashi_00000001_0000_4000_8000_000000000000</SKU>
    <Quantity>1</Quantity>
    <SellingStatus><QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
  </Item>
</GetItemResponse>`
}

// 指定した件数までは即座に返し、それ以降は中断されるまで応答しない
function mockEbayStallingAfter(fastCount: number) {
  let served = 0
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const itemId = String(init?.body ?? '').match(/<ItemID>([^<]+)<\/ItemID>/)?.[1] ?? ''
    if (served++ < fastCount) return new Response(itemResponse(itemId), { status: 200 })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
}

describe('個別照会が時間切れしたとき', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

  it('取得できた分は捨てず、時間切れを伝える', async () => {
    globalThis.fetch = mockEbayStallingAfter(2) as unknown as typeof fetch

    const result = await fetchListingsByItemIds(
      { accessToken: 'token' },
      ['item-1', 'item-2', 'item-3', 'item-4'],
      { totalTimeoutMs: 1_000, pageTimeoutMs: 5_000, concurrency: 1 },
    )

    // ここが本題。修正前は例外になり、同期ごと失敗していた
    expect(result.truncated).toBe(true)
    expect(result.items.map(item => item.ebayItemId)).toEqual(['item-1', 'item-2'])
  })

  it('全件取得できた回は時間切れを立てない', async () => {
    globalThis.fetch = mockEbayStallingAfter(10) as unknown as typeof fetch

    const result = await fetchListingsByItemIds(
      { accessToken: 'token' },
      ['item-1', 'item-2'],
      { totalTimeoutMs: 5_000, concurrency: 1 },
    )

    expect(result.truncated).toBe(false)
    expect(result.items).toHaveLength(2)
  })
})
