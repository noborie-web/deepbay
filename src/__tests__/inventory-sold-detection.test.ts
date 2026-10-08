import { describe, expect, it } from 'vitest'
import { resolveEndedReason } from '@/lib/inventory-sync'
import { parseGetItemResponse, isEndedListingInfo } from '@/lib/ebay-inventory'

// ユーザー報告(2026-10-08): 実際に売れた商品があるのに、売却済み(sold)の
// 商品が1件も記録されていなかった(出品中720件・取り下げ311件に対して sold 0件)。
// 原因は、終了した出品の売却判定を「前回同期時点の在庫数・売却数」で
// 行っていたこと。1個だけの出品が売れた場合、最後の記録は在庫1・売却0なので
// 必ず「取り下げ」と誤判定される。
describe('終了した出品の売却判定', () => {
  const freshSnapshot = { quantity: 1, quantity_sold: 0 }

  it('eBayが返した売却数が1以上なら売却済み（古い記録が在庫1・売却0でも）', () => {
    expect(resolveEndedReason(
      { quantitySold: 1, listingStatus: 'Completed' },
      freshSnapshot,
    )).toBe('sold')
  })

  it('eBayが売却数0を返したら取り下げ', () => {
    expect(resolveEndedReason(
      { quantitySold: 0, listingStatus: 'Ended' },
      freshSnapshot,
    )).toBe('delisted')
  })

  it('eBayから終了理由を取れない場合は、従来どおり古い記録で判定する', () => {
    expect(resolveEndedReason(undefined, { quantity: 0, quantity_sold: 1 })).toBe('sold')
    expect(resolveEndedReason(undefined, freshSnapshot)).toBe('delisted')
  })

  it('存在しないIDのように売却数が取れなかった場合は不明として扱う', () => {
    expect(resolveEndedReason(
      { quantitySold: null, listingStatus: null },
      freshSnapshot,
    )).toBe('unknown')
  })
})

describe('GetItemの終了レスポンス', () => {
  const endedXml = (status: string, sold: string) => `<?xml version="1.0"?>
<GetItemResponse><Ack>Success</Ack><Item>
  <ItemID>377535920770</ItemID>
  <Title>Sold item</Title>
  <Quantity>1</Quantity>
  <SellingStatus><ListingStatus>${status}</ListingStatus><QuantitySold>${sold}</QuantitySold></SellingStatus>
  <ListingDetails><EndTime>2026-10-01T00:00:00.000Z</EndTime></ListingDetails>
</Item></GetItemResponse>`

  it('終了済みでも売却数と終了日時を持ち帰る', () => {
    const result = parseGetItemResponse(endedXml('Completed', '1'), '377535920770')
    expect(isEndedListingInfo(result)).toBe(true)
    if (!isEndedListingInfo(result)) return
    expect(result).toEqual({
      ebayItemId: '377535920770',
      quantitySold: 1,
      listingStatus: 'Completed',
      endTime: '2026-10-01T00:00:00.000Z',
    })
  })

  it('売れずに終了した出品は売却数0として返す', () => {
    const result = parseGetItemResponse(endedXml('Ended', '0'), '377535920770')
    expect(isEndedListingInfo(result) && result.quantitySold).toBe(0)
  })

  it('出品中は従来どおり在庫情報を返す', () => {
    const activeXml = endedXml('Active', '0')
    const result = parseGetItemResponse(activeXml, '377535920770')
    expect(isEndedListingInfo(result)).toBe(false)
    expect(result !== 'not_found' && 'title' in result && result.title).toBe('Sold item')
  })
})
