import { describe, expect, it, vi } from 'vitest'
import { parseGetItemResponse, parseGetMyeBaySellingResponse } from '@/lib/ebay-inventory'
import { currencyForSite, resolveListingSite, tradingSiteIdFor } from '@/lib/ebay-sites'

// ユーザー要望(2026-09-25): UK/AUにも出品する。「混在しないよう細心の注意が
// 必要」。GBP/AUDの出品をUSDとして扱うと価格改定で大幅な値下げ=赤字になるため、
// 出品ごとにサイトと通貨を必ず取り出せることを担保する。
describe('出品のサイト・通貨の判定', () => {
  it('通貨からサイトを決める(通貨が価格の単位そのものなので最優先)', () => {
    expect(resolveListingSite('US', 'GBP')).toEqual({ siteId: 'UK', currency: 'GBP' })
    expect(resolveListingSite(null, 'AUD')).toEqual({ siteId: 'AU', currency: 'AUD' })
    expect(resolveListingSite(null, 'USD')).toEqual({ siteId: 'US', currency: 'USD' })
  })

  it('通貨が無ければサイト名から決める', () => {
    expect(resolveListingSite('United Kingdom', null)).toEqual({ siteId: 'UK', currency: 'GBP' })
    expect(resolveListingSite('Australia', '')).toEqual({ siteId: 'AU', currency: 'AUD' })
  })

  it('対応していないサイト・通貨は判定不能(null)にして価格改定の対象外にできるようにする', () => {
    expect(resolveListingSite('Germany', 'EUR')).toBeNull()
    expect(resolveListingSite(null, null)).toBeNull()
  })

  it('Trading APIのSiteIDと通貨がサイトごとに対応する', () => {
    expect(tradingSiteIdFor('UK')).toBe('3')
    expect(tradingSiteIdFor('AU')).toBe('15')
    expect(tradingSiteIdFor('US')).toBe('0')
    expect(tradingSiteIdFor(null)).toBe('0')
    expect(currencyForSite('UK')).toBe('GBP')
    expect(currencyForSite('AU')).toBe('AUD')
    expect(currencyForSite(undefined)).toBe('USD')
  })
})

describe('eBayレスポンスからのサイト・通貨の取り込み', () => {
  it('GetItemの CurrentPrice の currencyID からUK出品と判定する', () => {
    const xml = `<GetItemResponse><Ack>Success</Ack><Item>
      <ItemID>111</ItemID><Title>Camera</Title><SKU>kakehashi_p1</SKU>
      <Quantity>1</Quantity><Site>UK</Site>
      <SellingStatus><ListingStatus>Active</ListingStatus><QuantitySold>0</QuantitySold>
      <CurrentPrice currencyID="GBP">120.55</CurrentPrice></SellingStatus>
      <ListingDetails><StartTime>2026-09-01T00:00:00.000Z</StartTime></ListingDetails>
    </Item></GetItemResponse>`

    const parsed = parseGetItemResponse(xml, '111')
    expect(parsed).toMatchObject({ ebayItemId: '111', currentPrice: 120.55, siteId: 'UK', currency: 'GBP' })
  })

  it('GetMyeBaySelling/GetSellerListでもサイトと通貨を取り出す', () => {
    const xml = `<GetSellerListResponse><Ack>Success</Ack>
      <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
      <PageNumber>1</PageNumber>
      <Item><ItemID>222</ItemID><Title>Lens</Title><SKU>kakehashi_p2</SKU><Site>Australia</Site>
        <CurrentPrice currencyID="AUD">310.00</CurrentPrice><Quantity>1</Quantity>
        <QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></Item>
      <Item><ItemID>333</ItemID><Title>Bag</Title><SKU>kakehashi_p3</SKU><Site>US</Site>
        <CurrentPrice currencyID="USD">99.00</CurrentPrice><Quantity>1</Quantity>
        <QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></Item>
    </GetSellerListResponse>`

    const { items } = parseGetMyeBaySellingResponse(xml)
    expect(items.map(i => [i.ebayItemId, i.siteId, i.currency])).toEqual([
      ['222', 'AU', 'AUD'],
      ['333', 'US', 'USD'],
    ])
  })
})

describe('ReviseInventoryStatusのサイト分離', () => {
  it('サイトの違う出品を1リクエストに混ぜず、通貨とSiteIDをサイトごとに切り替える', async () => {
    const calls: Array<{ siteId: string | null; body: string }> = []
    const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ siteId: init.headers['X-EBAY-API-SITEID'], body: init.body })
      return { ok: true, text: async () => '<Ack>Success</Ack>' } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const { reviseInventoryStatusBatch } = await import('@/lib/ebay-actions')
    const { results } = await reviseInventoryStatusBatch('token', [
      { itemId: '1', price: 100, siteId: 'US' },
      { itemId: '2', price: 80, siteId: 'UK' },
      { itemId: '3', price: 200, siteId: 'AU' },
      { itemId: '4', price: 110, siteId: 'US' },
    ], { concurrency: 1 })

    expect(results.every(r => r.success)).toBe(true)
    // US / UK / AU の3リクエストに分かれる
    expect(calls).toHaveLength(3)
    const us = calls.find(c => c.siteId === '0')!
    const uk = calls.find(c => c.siteId === '3')!
    const au = calls.find(c => c.siteId === '15')!
    expect(us.body).toContain('currencyID="USD"')
    expect(us.body).toContain('<ItemID>1</ItemID>')
    expect(us.body).toContain('<ItemID>4</ItemID>')
    expect(uk.body).toContain('currencyID="GBP"')
    expect(uk.body).not.toContain('<ItemID>1</ItemID>')
    expect(au.body).toContain('currencyID="AUD"')

    vi.unstubAllGlobals()
  })
})
