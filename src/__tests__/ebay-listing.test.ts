import { describe, expect, it } from 'vitest'
import {
  buildAddFixedPriceItemXml,
  parseAddFixedPriceItemResponse,
} from '@/lib/ebay-listing'
import type { Product } from '@/types/database'

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: 'https://jp.mercari.com/item/m1',
    source_site: 'mercari',
    source_item_id: 'm1',
    source_lookup_code: 'ele_20260727_A2B3C4D5E6F7G8H9',
    original_title: 'Original',
    original_price: 6000,
    original_description: 'Original description',
    original_images: [],
    original_condition: '中古',
    ebay_title: 'Tamiya & Mini 4WD',
    ebay_brand: 'Tamiya',
    ebay_price: 83,
    ebay_description: 'Line <1>',
    ebay_images: [
      'https://static.mercdn.net/item/1.jpg?a=1&b=2',
      'https://static.mercdn.net/item/2.jpg',
    ],
    ebay_item_specifics: {
      Brand: ['Tamiya'],
      Platform: ['Nintendo GameCube'],
    },
    ebay_condition: '中古',
    ebay_category_id: '139973',
    listing_status: 'draft',
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: 6000,
    price_type: 'fixed',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
    ...overrides,
  }
}

const OPTIONS = {
  categoryId: '139973',
  paymentProfileName: 'eBay Payments',
  returnProfileName: 'Returns Accepted',
  shippingProfileName: 'Japan Shipping',
}

describe('eBay direct listing', () => {
  it('AddFixedPriceItem XMLへ商品・全画像・ポリシーを設定する', () => {
    const xml = buildAddFixedPriceItemXml(makeProduct(), OPTIONS, 'message-1')
    expect(xml).toContain('<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">')
    expect(xml).toContain('<Title>Tamiya &amp; Mini 4WD</Title>')
    expect(xml).toContain('<StartPrice currencyID="USD">83.00</StartPrice>')
    expect(xml).toContain('<ConditionID>5000</ConditionID>')
    expect(xml).toContain('<CategoryID>139973</CategoryID>')
    expect(xml).toContain('<PictureURL>https://static.mercdn.net/item/1.jpg?a=1&amp;b=2</PictureURL>')
    expect(xml.match(/<PictureURL>/g)).toHaveLength(2)
    expect(xml).toContain('<PaymentProfileName>eBay Payments</PaymentProfileName>')
    expect(xml).toContain('<ReturnProfileName>Returns Accepted</ReturnProfileName>')
    expect(xml).toContain('<ShippingProfileName>Japan Shipping</ShippingProfileName>')
    expect(xml).toContain('<Name>Platform</Name><Value>Nintendo GameCube</Value>')
    expect(xml).toContain('<SKU>ele_20260727_A2B3C4D5E6F7G8H9</SKU>')
    expect(xml).not.toContain('<SKU>https://jp.mercari.com')
  })

  it('成功レスポンスからItem IDと警告を取得する', () => {
    expect(parseAddFixedPriceItemResponse(`
      <AddFixedPriceItemResponse>
        <Ack>Warning</Ack>
        <ItemID>1234567890</ItemID>
        <Errors><LongMessage>Category recommendation</LongMessage></Errors>
      </AddFixedPriceItemResponse>
    `)).toEqual({
      itemId: '1234567890',
      warningMessages: ['Category recommendation'],
    })
  })

  it('失敗レスポンスはeBayの詳細メッセージを返す', () => {
    expect(() => parseAddFixedPriceItemResponse(`
      <AddFixedPriceItemResponse>
        <Ack>Failure</Ack>
        <Errors><ErrorCode>21919303</ErrorCode><LongMessage>Title is invalid</LongMessage></Errors>
      </AddFixedPriceItemResponse>
    `)).toThrow('Title is invalid')
  })
})
