import { beforeEach, describe, expect, it, vi } from 'vitest'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
// 既存ツールで起きた重大な不具合(2026-07-18)の再発防止が要点:
// 価格バッチが失敗したとき、そのASINを「価格0」で確定させない。
const mocks = vi.hoisted(() => ({
  loadAmazonCredentials: vi.fn(),
  fetchAccessToken: vi.fn(),
  fetchCatalogItems: vi.fn(),
  fetchItemOffersBatch: vi.fn(),
}))

vi.mock('@/lib/amazon-credentials', () => ({ loadAmazonCredentials: mocks.loadAmazonCredentials }))
vi.mock('@/lib/amazon-spapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/amazon-spapi')>()
  return {
    ...actual,
    fetchAccessToken: mocks.fetchAccessToken,
    fetchCatalogItems: mocks.fetchCatalogItems,
    fetchItemOffersBatch: mocks.fetchItemOffersBatch,
  }
})

import { fetchAmazonProducts } from '@/lib/amazon-extract'

const offersPayload = (price: number, extra: Record<string, unknown> = {}) => ({
  Offers: [{
    SubCondition: 'new',
    ListingPrice: { Amount: price },
    Shipping: { Amount: 0 },
    ...extra,
  }],
})

describe('ASINからの抽出', () => {
  beforeEach(() => {
    mocks.loadAmazonCredentials.mockReset().mockResolvedValue({
      clientId: 'id', clientSecret: 's', refreshToken: 'r', marketplaceId: 'A1VC38T7YXB528',
    })
    mocks.fetchAccessToken.mockReset().mockResolvedValue({ accessToken: 'token', expiresInSec: 3600 })
    mocks.fetchCatalogItems.mockReset().mockResolvedValue(new Map([
      ['B0F18J2CJF', { asin: 'B0F18J2CJF', title: 'Test Item', brand: 'CASIO', imageUrls: ['https://img/1.jpg'] }],
    ]))
    mocks.fetchItemOffersBatch.mockReset().mockResolvedValue({
      payloads: new Map([['B0F18J2CJF', offersPayload(5000)]]),
      failed: [],
    })
  })

  it('カタログと価格を合わせて、抽出パイプラインに渡せる形にする', async () => {
    const result = await fetchAmazonProducts({} as never, 'user-1', ['B0F18J2CJF'], { offersIntervalMs: 0 })

    expect(result.products).toHaveLength(1)
    expect(result.products[0]).toMatchObject({
      sourceUrl: 'https://www.amazon.co.jp/dp/B0F18J2CJF',
      sourceSite: 'amazon',
      sourceItemId: 'B0F18J2CJF',
      title: 'Test Item',
      price: 5000,
      condition: '新品',
      availability: 'available',
    })
  })

  it('送料は仕入値に含める（eBay価格の原価にするため）', async () => {
    mocks.fetchItemOffersBatch.mockResolvedValue({
      payloads: new Map([['B0F18J2CJF', {
        Offers: [{ SubCondition: 'new', ListingPrice: { Amount: 5000 }, Shipping: { Amount: 500 } }],
      }]]),
      failed: [],
    })

    const result = await fetchAmazonProducts({} as never, 'user-1', ['B0F18J2CJF'], { offersIntervalMs: 0 })
    expect(result.products[0].price).toBe(5500)
  })

  // 2026-07-18の不具合: バッチ失敗分を価格0で確定保存し、17.6万件中2万件が壊れた
  it('価格を取得できなかったASINは商品にせず、次回に回す', async () => {
    mocks.fetchItemOffersBatch.mockResolvedValue({ payloads: new Map(), failed: ['B0F18J2CJF'] })

    const result = await fetchAmazonProducts({} as never, 'user-1', ['B0F18J2CJF'], { offersIntervalMs: 0 })

    expect(result.products).toHaveLength(0)
    expect(result.pricingFailed).toEqual(['B0F18J2CJF'])
    // 価格0の商品を作らない
    expect(result.products.some((p) => p.price === 0)).toBe(false)
  })

  it('新品のオファーが無いASINは仕入れ不可として分ける', async () => {
    mocks.fetchItemOffersBatch.mockResolvedValue({
      payloads: new Map([['B0F18J2CJF', { Offers: [] }]]),
      failed: [],
    })

    const result = await fetchAmazonProducts({} as never, 'user-1', ['B0F18J2CJF'], { offersIntervalMs: 0 })
    expect(result.noOffer).toEqual(['B0F18J2CJF'])
    expect(result.products).toHaveLength(0)
  })

  it('FBAのみ指定なら、自社発送のオファーは対象外にする', async () => {
    mocks.fetchItemOffersBatch.mockResolvedValue({
      payloads: new Map([['B0F18J2CJF', offersPayload(5000, { IsFulfilledByAmazon: false })]]),
      failed: [],
    })

    const result = await fetchAmazonProducts({} as never, 'user-1', ['B0F18J2CJF'], {
      offersIntervalMs: 0, fbaOnly: true,
    })
    expect(result.products).toHaveLength(0)
    expect(result.noOffer).toEqual(['B0F18J2CJF'])
  })

  it('20件ずつに分けて価格を取る（SP-APIの上限）', async () => {
    const asins = Array.from({ length: 45 }, (_, i) => `B${i.toString().padStart(9, '0')}`)
    mocks.fetchItemOffersBatch.mockResolvedValue({ payloads: new Map(), failed: [] })

    await fetchAmazonProducts({} as never, 'user-1', asins, { offersIntervalMs: 0 })

    const sizes = mocks.fetchItemOffersBatch.mock.calls.map((call) => (call[1] as string[]).length)
    expect(sizes).toEqual([20, 20, 5])
  })

  it('接続していなければ、何をすべきか分かるエラーを出す', async () => {
    mocks.loadAmazonCredentials.mockResolvedValue(null)

    await expect(fetchAmazonProducts({} as never, 'user-1', ['B0F18J2CJF'], { offersIntervalMs: 0 }))
      .rejects.toThrow(/仕入先連携/)
  })

  it('時間切れになったら、残りは処理せず分けて返す', async () => {
    const asins = Array.from({ length: 40 }, (_, i) => `B${i.toString().padStart(9, '0')}`)
    mocks.fetchItemOffersBatch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { payloads: new Map(), failed: [] }
    })

    const result = await fetchAmazonProducts({} as never, 'user-1', asins, {
      offersIntervalMs: 0, timeBudgetMs: 20,
    })
    expect(result.skipped).toHaveLength(20)
  })
})
