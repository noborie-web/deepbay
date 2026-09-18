import { describe, expect, it } from 'vitest'
import { conditionFromEbayId, extractDescriptionBody, parseGetItemDetails } from '@/lib/ebay-item-details'

// ユーザー要望(事故復旧): 抽出の削除で消えた出品済み商品を eBay の出品から
// 復元するため、GetItem の詳細(説明・画像・状態・カテゴリ)を取り出す。
const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <ItemID>298670540821</ItemID>
    <Title>[GOLD SEAL] GREAT PUNK HITS &amp; more</Title>
    <SKU>kakehashi_2f70db52_65e8_4698_bf86_9a7cc13d79fe</SKU>
    <Quantity>1</Quantity>
    <ConditionID>5000</ConditionID>
    <Description><![CDATA[<meta charset="utf-8"><div><h2>Description</h2><p>Condition: <strong>中古</strong></p><p>Yellow seal obi included.<br>Minor scratches on the case.</p><h2>Shipping</h2><p>Shipping from Japan.</p></div>]]></Description>
    <PrimaryCategory><CategoryID>176984</CategoryID><CategoryName>Music &gt; CDs</CategoryName></PrimaryCategory>
    <SellingStatus>
      <CurrentPrice currencyID="USD">530.09</CurrentPrice>
      <QuantitySold>0</QuantitySold>
      <ListingStatus>Active</ListingStatus>
    </SellingStatus>
    <ListingDetails><StartTime>2026-09-13T11:55:59.000Z</StartTime></ListingDetails>
    <PictureDetails>
      <PictureURL>https://i.ebayimg.com/images/g/a/s-l1600.jpg</PictureURL>
      <PictureURL>https://i.ebayimg.com/images/g/b/s-l1600.jpg</PictureURL>
    </PictureDetails>
  </Item>
</GetItemResponse>`

describe('parseGetItemDetails', () => {
  it('タイトル・SKU・説明HTML・画像・価格・状態・カテゴリ・出品日時を取り出す', () => {
    const d = parseGetItemDetails(xml, '298670540821')
    expect(d).not.toBe('not_found')
    if (d === 'not_found') return
    expect(d).toMatchObject({
      itemId: '298670540821',
      sku: 'kakehashi_2f70db52_65e8_4698_bf86_9a7cc13d79fe',
      title: '[GOLD SEAL] GREAT PUNK HITS & more',
      currentPrice: 530.09, quantity: 1, quantitySold: 0, listingStatus: 'Active',
      conditionId: '5000', categoryId: '176984', startTime: '2026-09-13T11:55:59.000Z',
    })
    expect(d.pictureUrls).toEqual(['https://i.ebayimg.com/images/g/a/s-l1600.jpg', 'https://i.ebayimg.com/images/g/b/s-l1600.jpg'])
    expect(d.descriptionHtml).toContain('<h2>Description</h2>')
  })

  it('存在しないItemIDは not_found', () => {
    expect(parseGetItemDetails('<GetItemResponse><Ack>Failure</Ack><Errors><ErrorCode>17</ErrorCode></Errors></GetItemResponse>', 'x')).toBe('not_found')
  })
})

describe('extractDescriptionBody', () => {
  it('Kakehashiの説明文HTMLから本文だけを取り出し、改行を保つ', () => {
    const d = parseGetItemDetails(xml, '298670540821')
    if (d === 'not_found') throw new Error('unexpected')
    expect(extractDescriptionBody(d.descriptionHtml)).toBe('Yellow seal obi included.\nMinor scratches on the case.')
  })

  it('それ以外のHTMLはタグを除いたテキストにする', () => {
    expect(extractDescriptionBody('<div><p>Sealed &amp; new</p><p>Ships fast</p></div>')).toBe('Sealed & new\n\nShips fast')
  })
})

describe('conditionFromEbayId', () => {
  it('本番のメディア用ConditionIDをKakehashiの商品状態に戻す', () => {
    expect(conditionFromEbayId('2750')).toBe('新品同様')
    expect(conditionFromEbayId('4000')).toBe('良い')
    expect(conditionFromEbayId('5000')).toBe('中古')
    expect(conditionFromEbayId('6000')).toBe('ジャンク')
    expect(conditionFromEbayId('3000')).toBe('中古')
    expect(conditionFromEbayId(null)).toBeNull()
  })
})
