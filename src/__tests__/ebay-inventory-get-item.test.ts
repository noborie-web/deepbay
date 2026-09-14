import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchListingsByItemIds, parseGetItemResponse } from '@/lib/ebay-inventory'

// ユーザー要望・実データで確認した不具合: eBayアカウント上には他ツールで
// 出品中の商品が約1万件あり、全active出品を走査する方式では最後まで走り
// 切れずKakehashiの出品が同期できなかった。Kakehashiが出品したItemIDだけを
// GetItemで個別照会する。
function getItemXml(opts: {
  itemId: string
  status?: string
  quantity?: number
  sold?: number
  price?: number
  sku?: string
  title?: string
}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <ItemID>${opts.itemId}</ItemID>
    <Title>${opts.title ?? 'Test Item'}</Title>
    <SKU>${opts.sku ?? 'kakehashi_01234567_89ab_cdef_0123_456789abcdef'}</SKU>
    <Quantity>${opts.quantity ?? 1}</Quantity>
    <SellingStatus>
      <CurrentPrice currencyID="USD">${opts.price ?? 150.5}</CurrentPrice>
      <QuantitySold>${opts.sold ?? 0}</QuantitySold>
      <ListingStatus>${opts.status ?? 'Active'}</ListingStatus>
    </SellingStatus>
    <ListingDetails>
      <StartTime>2026-09-13T11:55:59.000Z</StartTime>
      <EndTime>2026-10-13T11:55:59.000Z</EndTime>
    </ListingDetails>
    <PictureDetails>
      <PictureURL>https://i.ebayimg.com/images/g/abc/s-l1600.jpg</PictureURL>
      <PictureURL>https://i.ebayimg.com/images/g/def/s-l1600.jpg</PictureURL>
    </PictureDetails>
  </Item>
</GetItemResponse>`
}

function failureXml(code: string, message = 'Item cannot be accessed.'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <ShortMessage>${message}</ShortMessage>
    <LongMessage>${message}</LongMessage>
    <ErrorCode>${code}</ErrorCode>
    <SeverityCode>Error</SeverityCode>
  </Errors>
</GetItemResponse>`
}

describe('parseGetItemResponse', () => {
  it('activeな出品をInventoryListingInputに変換し、残数=総数-売れた数で求める', () => {
    const result = parseGetItemResponse(getItemXml({ itemId: '318865179224', quantity: 3, sold: 1 }), '318865179224')
    expect(result).toMatchObject({
      ebayItemId: '318865179224',
      customLabel: 'kakehashi_01234567_89ab_cdef_0123_456789abcdef',
      title: 'Test Item',
      currentPrice: 150.5,
      quantity: 2,
      quantitySold: 1,
      listingStatus: 'Active',
      startTime: '2026-09-13T11:55:59.000Z',
      endTime: '2026-10-13T11:55:59.000Z',
      imageUrl: 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg',
    })
  })

  it('売り切れ(残数0)は quantity=0 として返す', () => {
    const result = parseGetItemResponse(getItemXml({ itemId: 'x', quantity: 1, sold: 1 }), 'x')
    expect(result).toMatchObject({ quantity: 0, quantitySold: 1 })
  })

  it('終了済み(Completed/Ended)の出品は ended として返す', () => {
    expect(parseGetItemResponse(getItemXml({ itemId: 'x', status: 'Completed' }), 'x')).toBe('ended')
    expect(parseGetItemResponse(getItemXml({ itemId: 'x', status: 'Ended' }), 'x')).toBe('ended')
  })

  it('存在しない/参照できないItemIDのエラーは not_found として返し、例外にしない', () => {
    expect(parseGetItemResponse(failureXml('17'), 'x')).toBe('not_found')
    expect(parseGetItemResponse(failureXml('37', 'Invalid ItemID'), 'x')).toBe('not_found')
  })

  it('それ以外のAPIエラーは例外にする', () => {
    expect(() => parseGetItemResponse(failureXml('931', 'Auth token is invalid.'), 'x'))
      .toThrow('eBay GetItem error (x): Auth token is invalid.')
  })
})

describe('fetchListingsByItemIds', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('ItemIDごとにGetItemを呼び、activeな出品と終了済みIDを振り分ける', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      const itemId = body.match(/<ItemID>([^<]+)<\/ItemID>/)?.[1] ?? ''
      calls.push(itemId)
      expect(String((init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME'])).toBe('GetItem')
      if (itemId === 'ended-1') return new Response(getItemXml({ itemId, status: 'Completed' }), { status: 200 })
      if (itemId === 'missing-1') return new Response(failureXml('17'), { status: 200 })
      return new Response(getItemXml({ itemId }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchListingsByItemIds(
      { accessToken: 'token' },
      ['active-1', 'ended-1', 'active-2', 'missing-1', 'active-1'],
    )

    // 重複IDは1回だけ照会する
    expect(calls.sort()).toEqual(['active-1', 'active-2', 'ended-1', 'missing-1'])
    expect(result.items.map(i => i.ebayItemId).sort()).toEqual(['active-1', 'active-2'])
    expect(result.endedItemIds.sort()).toEqual(['ended-1', 'missing-1'])
  })

  it('照会対象が空なら何も呼ばない', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await fetchListingsByItemIds({ accessToken: 'token' }, [])
    expect(result).toEqual({ items: [], endedItemIds: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
