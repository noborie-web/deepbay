import { describe, expect, it } from 'vitest'
import { isStrictNew, pickBestNewOffer, UNBUYABLE_PRICE_RATIO } from '@/lib/amazon-offers'

// 既存のPythonツールが実データで踏んだ落とし穴を移植したので、同じケースを固定する。
// 無在庫の仕入判断に直結し、ここを誤ると「実際には買えない価格」で出品してしまう。
const offer = (price: number, extra: Record<string, unknown> = {}) => ({
  SubCondition: 'new',
  ListingPrice: { Amount: price, CurrencyCode: 'JPY' },
  Shipping: { Amount: 0, CurrencyCode: 'JPY' },
  ...extra,
})

describe('新品オファーの選定', () => {
  it('本体価格が最安のものを選ぶ', () => {
    const picked = pickBestNewOffer({ Offers: [offer(3000), offer(2500), offer(4000)] })
    expect(picked?.listingPriceJpy).toBe(2500)
  })

  it('同額なら送料が安い方を選ぶ', () => {
    const picked = pickBestNewOffer({
      Offers: [
        offer(2500, { Shipping: { Amount: 500 } }),
        offer(2500, { Shipping: { Amount: 0 } }),
      ],
    })
    expect(picked?.shippingJpy).toBe(0)
  })

  // 実データ(2026-07-19): B0F18J2CJF は招待限定オファーが¥5,412で返るが、
  // 一般客が買えるカートボックス価格は¥13,250だった。
  it('招待限定とみられる極端に安いオファーを除外する', () => {
    const picked = pickBestNewOffer({
      Offers: [offer(5412), offer(13250, { IsBuyBoxWinner: true })],
      Summary: { BuyBoxPrices: [{ condition: 'new', ListingPrice: { Amount: 13250 } }] },
    })
    expect(picked?.listingPriceJpy).toBe(13250)
    expect(picked?.excludedUnbuyable).toBe(1)
  })

  it('カートボックスを取っているオファーは安くても除外しない', () => {
    const picked = pickBestNewOffer({
      Offers: [offer(5000, { IsBuyBoxWinner: true })],
      Summary: { BuyBoxPrices: [{ condition: 'new', ListingPrice: { Amount: 13250 } }] },
    })
    expect(picked?.listingPriceJpy).toBe(5000)
    expect(picked?.excludedUnbuyable).toBe(0)
  })

  it('カートボックスが無い場合は2番目に安いオファーを基準にする', () => {
    // 2番目が10000なので、その半額未満(=5000未満)は除外
    const picked = pickBestNewOffer({ Offers: [offer(3700), offer(10000), offer(12000)] })
    expect(picked?.listingPriceJpy).toBe(10000)
    expect(picked?.excludedUnbuyable).toBe(1)
  })

  it('正常な価格差(0.66倍など)は除外しない', () => {
    const picked = pickBestNewOffer({ Offers: [offer(6600), offer(10000)] })
    expect(picked?.listingPriceJpy).toBe(6600)
    expect(picked?.excludedUnbuyable).toBe(0)
  })

  it('中古オファーは対象にしない', () => {
    const picked = pickBestNewOffer({
      Offers: [offer(1000, { SubCondition: 'used' }), offer(5000)],
    })
    expect(picked?.listingPriceJpy).toBe(5000)
  })

  it('Amazon発送は IsFulfilledByAmazon で判定する（FulfillmentChannelは使えない）', () => {
    const picked = pickBestNewOffer({ Offers: [offer(2500, { IsFulfilledByAmazon: true })] })
    expect(picked?.isFba).toBe(true)
  })

  it('新品のオファーが無ければ null', () => {
    expect(pickBestNewOffer({ Offers: [offer(1000, { SubCondition: 'used' })] })).toBeNull()
    expect(pickBestNewOffer({ Offers: [] })).toBeNull()
    expect(pickBestNewOffer(null)).toBeNull()
  })

  it('除外のしきい値は半額', () => {
    expect(UNBUYABLE_PRICE_RATIO).toBe(0.5)
  })
})

describe('新品かどうかの判定', () => {
  it('Like New(ほぼ新品)は新品として扱わない', () => {
    expect(isStrictNew('Like New')).toBe(false)
    expect(isStrictNew('new')).toBe(true)
    expect(isStrictNew('Brand New')).toBe(true)
    expect(isStrictNew('used')).toBe(false)
  })
})
