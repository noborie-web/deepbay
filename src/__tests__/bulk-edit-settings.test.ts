import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BULK_EDIT_CONFIG,
  evaluateBulkProduct,
  normalizeBulkEditConfig,
} from '@/lib/bulk-edit-settings'
import type { ScrapedProduct } from '@/lib/scrapers/types'

function product(patch: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    sourceUrl: 'https://example.com/item/1',
    sourceSite: 'mercari',
    sourceItemId: '1',
    title: 'Nintendo game',
    price: 5000,
    description: 'Good condition',
    images: ['https://example.com/1.jpg'],
    condition: '中古',
    category: null,
    sellerRatingCount: 20,
    sellerLowRatingCount: 1,
    shippingDays: 2,
    sourceUpdatedAt: '2026-07-01T00:00:00.000Z',
    ...patch,
  }
}

describe('normalizeBulkEditConfig', () => {
  it('旧設定では従来どおり危険セラーと危険単語を有効にする', () => {
    const config = normalizeBulkEditConfig({})
    expect(config.dangerSellerEnabled).toBe(true)
    expect(config.dangerWordEnabled).toBe(true)
  })

  it('不正な数値はnullに正規化する', () => {
    const config = normalizeBulkEditConfig({ minPrice: 'invalid', maxPrice: '10000' })
    expect(config.minPrice).toBeNull()
    expect(config.maxPrice).toBe(10000)
  })
})

describe('evaluateBulkProduct', () => {
  it('Veroブランドを指定対象列で個別商品ごとに判定する', () => {
    const match = evaluateBulkProduct(
      product(),
      { ...DEFAULT_BULK_EDIT_CONFIG, dangerWordEnabled: false, veroEnabled: true },
      { veroBrands: ['Nintendo'], dangerWords: [] },
    )
    expect(match?.reasonCode).toBe('vero')
  })

  it('価格・評価・発送日・更新月の条件を判定する', () => {
    const price = evaluateBulkProduct(
      product(),
      { ...DEFAULT_BULK_EDIT_CONFIG, dangerWordEnabled: false, priceRangeEnabled: true, minPrice: 6000 },
      { veroBrands: [], dangerWords: [] },
    )
    expect(price?.reasonCode).toBe('price_range')

    const rating = evaluateBulkProduct(
      product(),
      { ...DEFAULT_BULK_EDIT_CONFIG, dangerWordEnabled: false, ratingCountEnabled: true, minRatingCount: 21 },
      { veroBrands: [], dangerWords: [] },
    )
    expect(rating?.reasonCode).toBe('rating_count')

    const shipping = evaluateBulkProduct(
      product(),
      { ...DEFAULT_BULK_EDIT_CONFIG, dangerWordEnabled: false, shippingDaysEnabled: true, maxShippingDays: 1 },
      { veroBrands: [], dangerWords: [] },
    )
    expect(shipping?.reasonCode).toBe('shipping_days')

    const updated = evaluateBulkProduct(
      product({ sourceUpdatedAt: '2025-01-01T00:00:00.000Z' }),
      { ...DEFAULT_BULK_EDIT_CONFIG, dangerWordEnabled: false, updatedWithinEnabled: true, updatedWithinMonths: 3 },
      { veroBrands: [], dangerWords: [] },
      new Date('2026-07-31T00:00:00.000Z'),
    )
    expect(updated?.reasonCode).toBe('updated_months')
  })

  it('取得できない任意情報は誤って除外しない', () => {
    const match = evaluateBulkProduct(
      product({
        sellerRatingCount: null,
        sellerLowRatingCount: null,
        shippingDays: null,
        sourceUpdatedAt: null,
      }),
      {
        ...DEFAULT_BULK_EDIT_CONFIG,
        dangerWordEnabled: false,
        ratingCountEnabled: true,
        minRatingCount: 10,
        lowRatingEnabled: true,
        maxLowRatingCount: 0,
        shippingDaysEnabled: true,
        maxShippingDays: 1,
        updatedWithinEnabled: true,
        updatedWithinMonths: 1,
      },
      { veroBrands: [], dangerWords: [] },
    )
    expect(match).toBeNull()
  })
})

