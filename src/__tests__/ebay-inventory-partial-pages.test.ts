import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchActiveListingsBatch } from '@/lib/ebay-inventory'

// 本番で確認した不具合(2026-10-31): 一覧取得(GetMyeBaySelling)が合計時間の上限に
// 達すると、それまでに取得できたページまで捨てて例外にしていた。akebono-32 は
// 一覧取得が毎回40秒を超えるため、4回/日×9日間すべての同期が
// 「対象526件のうち1件も取得できなかった (exceeded 40000ms)」で終わり、
// 在庫が10/22から一度も更新されていなかった。
// 時間切れは「取れたところまで」で返し、続きは次回に回す。
function sellingResponse(page: number, totalPages: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ActiveList>
    <ItemArray>
      <Item>
        <ItemID>item-${page}</ItemID>
        <Title>Item ${page}</Title>
        <SKU>kakehashi_${String(page).padStart(8, '0')}_0000_4000_8000_000000000000</SKU>
        <Quantity>1</Quantity>
        <QuantitySold>0</QuantitySold>
        <ListingStatus>Active</ListingStatus>
      </Item>
    </ItemArray>
    <PaginationResult>
      <TotalNumberOfPages>${totalPages}</TotalNumberOfPages>
      <TotalNumberOfEntries>${totalPages}</TotalNumberOfEntries>
    </PaginationResult>
    <PageNumber>${page}</PageNumber>
  </ActiveList>
</GetMyeBaySellingResponse>`
}

// 指定したページまでは即座に返し、それ以降は中断されるまで応答しない。
function mockEbayStallingAfter(lastFastPage: number, totalPages: number) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    const page = Number(body.match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1] ?? '1')
    if (page <= lastFastPage) return new Response(sellingResponse(page, totalPages), { status: 200 })
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
}

describe('一覧取得が時間切れしたとき', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

  it('取得できたページは捨てず、読めなかったページから次回を再開する', async () => {
    globalThis.fetch = mockEbayStallingAfter(2, 5) as unknown as typeof fetch

    const result = await fetchActiveListingsBatch({ accessToken: 'token' }, 1, 5, {
      totalTimeoutMs: 1_000,
      pageTimeoutMs: 5_000,
      concurrency: 1,
    })

    expect(result.items.map(item => item.ebayItemId)).toEqual(['item-1', 'item-2'])
    // 読めなかったページ(3)から次回を再開する
    expect(result.nextPage).toBe(3)
    expect(result.lastFetchedPage).toBe(2)
    // 読み切れていないことは呼び出し側に伝える(完了扱いにしない)
    expect(result.truncated).toBe(true)
  })

  it('1ページ目すら取得できなければ例外にする(返せるものが無い)', async () => {
    globalThis.fetch = mockEbayStallingAfter(0, 5) as unknown as typeof fetch

    await expect(fetchActiveListingsBatch({ accessToken: 'token' }, 1, 5, {
      totalTimeoutMs: 1_000,
      pageTimeoutMs: 5_000,
      concurrency: 1,
    })).rejects.toThrow(/exceeded 1000ms/)
  })
})
