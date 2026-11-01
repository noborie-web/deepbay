import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchActiveListingsBatch } from '@/lib/ebay-inventory'

// 本番で確認した不具合(2026-11-01): akebono-32 のeBayアカウントには他ツールの
// 出品が10,000件以上あり、Kakehashiの出品1,023件はページ上限(50ページ)より
// 後ろにいる。一覧取得そのものは成功する(10,386件)のに照会対象は1件も含まれず、
// さらに取得予算を使い切るので個別照会のフォールバックまで飛ばされ、
// processed:0 が何日も続いていた。
// 1ページ目で「上限までに届かない」と分かるので、そこで打ち切る。
function sellingResponse(page: number, totalPages: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ActiveList>
    <ItemArray>
      <Item>
        <ItemID>item-${page}</ItemID>
        <Title>Item ${page}</Title>
        <SKU>other-tool-${page}</SKU>
        <Quantity>1</Quantity>
        <QuantitySold>0</QuantitySold>
        <ListingStatus>Active</ListingStatus>
      </Item>
    </ItemArray>
    <PaginationResult>
      <TotalNumberOfPages>${totalPages}</TotalNumberOfPages>
      <TotalNumberOfEntries>${totalPages * 200}</TotalNumberOfEntries>
    </PaginationResult>
    <PageNumber>${page}</PageNumber>
  </ActiveList>
</GetMyeBaySellingResponse>`
}

function mockEbay(totalPages: number) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    const page = Number(body.match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1] ?? '1')
    return new Response(sellingResponse(page, totalPages), { status: 200 })
  })
}

describe('出品数がページ上限を超えているアカウント', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

  it('stopIfExceedsPageCap を指定すると1ページ目で打ち切り、取得結果を返さない', async () => {
    const fetchMock = mockEbay(142)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchActiveListingsBatch({ accessToken: 'token' }, 1, 50, {
      totalTimeoutMs: 60_000,
      stopIfExceedsPageCap: true,
    })

    expect(result.stoppedAtPageCap).toBe(true)
    expect(result.ebayTotalPages).toBe(142)
    // 使えない結果を「取れた分」として返すと、呼び出し側が照会済みと誤解する
    expect(result.items).toEqual([])
    expect(result.nextPage).toBeNull()
    // 1ページだけで判定する(50ページ取ってから捨てるのでは予算を使い切る)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('指定しなければ従来どおり上限まで取得する', async () => {
    const fetchMock = mockEbay(142)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchActiveListingsBatch({ accessToken: 'token' }, 1, 3, {
      totalTimeoutMs: 60_000,
      concurrency: 1,
    })

    expect(result.stoppedAtPageCap).toBeUndefined()
    expect(result.truncated).toBe(true)
    expect(result.items.map(item => item.ebayItemId)).toEqual(['item-1', 'item-2', 'item-3'])
  })

  it('上限を超えていなければ打ち切らない', async () => {
    const fetchMock = mockEbay(3)
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchActiveListingsBatch({ accessToken: 'token' }, 1, 50, {
      totalTimeoutMs: 60_000,
      concurrency: 1,
      stopIfExceedsPageCap: true,
    })

    expect(result.stoppedAtPageCap).toBeUndefined()
    expect(result.items.map(item => item.ebayItemId)).toEqual(['item-1', 'item-2', 'item-3'])
  })
})
