import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchActiveListingsBatch, fetchAllActiveListings } from '@/lib/ebay-inventory'

// 実データで確認した不具合: 取得上限(以前は25ページ=5,000件)を超える
// active出品があると、後ろの出品が黙って欠落し、Kakehashiで直近に出品した
// 149件が在庫管理に1件も紐付かなかった。上限を引き上げるとともに、超過時は
// truncatedで呼び出し側へ知らせる。
function sellingResponse(page: number, totalPages: number, itemsPerPage = 1): string {
  const items = Array.from({ length: itemsPerPage }, (_, index) => `
    <Item>
      <ItemID>item-${page}-${index}</ItemID>
      <Title>Item ${page}-${index}</Title>
      <SKU>kakehashi_${String(page).padStart(8, '0')}_0000_4000_8000_${String(index).padStart(12, '0')}</SKU>
      <Quantity>1</Quantity>
      <QuantitySold>0</QuantitySold>
      <ListingStatus>Active</ListingStatus>
    </Item>`).join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ActiveList>
    <ItemArray>${items}</ItemArray>
    <PaginationResult>
      <TotalNumberOfPages>${totalPages}</TotalNumberOfPages>
      <TotalNumberOfEntries>${totalPages * itemsPerPage}</TotalNumberOfEntries>
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

describe('eBay active listing fetch cap', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

  it('eBay側の総ページ数が上限以内なら全ページを取得し、truncated=falseを返す', async () => {
    globalThis.fetch = mockEbay(3) as unknown as typeof fetch

    const result = await fetchActiveListingsBatch({ accessToken: 'token' }, 1, 10)

    expect(result.truncated).toBe(false)
    expect(result.ebayTotalPages).toBe(3)
    expect(result.totalPages).toBe(3)
    expect(result.nextPage).toBeNull()
    expect(result.items).toHaveLength(3)
  })

  it('50ページ(10,000件)までは打ち切らずに取得できる', async () => {
    globalThis.fetch = mockEbay(50) as unknown as typeof fetch

    const items = await fetchAllActiveListings({ accessToken: 'token' })

    // 以前の上限(25ページ)なら25件で止まっていた
    expect(items).toHaveLength(50)
  })

  it('eBay側の総ページ数が上限を超える場合はtruncated=trueと実際のページ数を返す', async () => {
    globalThis.fetch = mockEbay(60) as unknown as typeof fetch

    const result = await fetchActiveListingsBatch({ accessToken: 'token' }, 1, 4)

    expect(result.truncated).toBe(true)
    expect(result.ebayTotalPages).toBe(60)
    expect(result.totalPages).toBe(50)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('exceed the fetch cap'))
  })
})
