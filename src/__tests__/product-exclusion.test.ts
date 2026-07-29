import { describe, expect, it } from 'vitest'
import type { Product } from '@/types/database'
import {
  findDangerSellerProductIds,
  findPriceTypeProductIds,
  findPriceRangeProductIds,
  findSellerRatingProductIds,
  findShippingDaysProductIds,
  findTitleKeywordProductIds,
  findUpdatedAtProductIds,
  findVeroProductIds,
  getProductPriceType,
  matchesVeroBrand,
} from '@/lib/product-exclusion'

function makeProduct(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: `https://example.com/${id}`,
    source_site: 'mercari',
    source_item_id: id,
    original_title: `Title ${id}`,
    original_price: 1000,
    original_description: null,
    original_images: [],
    original_condition: null,
    ebay_title: null,
    ebay_brand: null,
    ebay_price: null,
    ebay_description: null,
    ebay_images: [],
    ebay_item_specifics: {},
    ebay_condition: null,
    ebay_category_id: null,
    listing_status: 'draft',
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: null,
    price_type: 'fixed',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('Vero除外判定', () => {
  it('eBayブランドを大文字小文字を区別せず照合する', () => {
    const product = makeProduct('p1', { ebay_brand: 'Nintendo' })
    expect(matchesVeroBrand(product, ['nintendo'])).toBe(true)
  })

  it('商品タイトル内のVeroブランドを照合する', () => {
    const product = makeProduct('p1', { original_title: 'SONY PlayStation 5 Console' })
    expect(matchesVeroBrand(product, ['Sony'])).toBe(true)
  })

  it('個別商品詳細の説明文内のVeroブランドを照合する', () => {
    const product = makeProduct('p1', {
      original_title: 'Vintage console',
      original_description: 'Made by Nintendo',
    })
    expect(matchesVeroBrand(product, ['Nintendo'])).toBe(true)
  })

  it('英数字ブランドは単語の途中に誤一致しない', () => {
    const product = makeProduct('p1', { original_title: 'Space Adventure' })
    expect(matchesVeroBrand(product, ['ACE'])).toBe(false)
  })

  it('全角・半角を正規化して照合する', () => {
    const product = makeProduct('p1', { original_title: 'ＮＩＫＥ スニーカー' })
    expect(matchesVeroBrand(product, ['NIKE'])).toBe(true)
  })

  it('空のブランド設定は無視する', () => {
    const product = makeProduct('p1', { original_title: 'Any Product' })
    expect(matchesVeroBrand(product, ['', '   '])).toBe(false)
  })

  it('一致した商品のIDだけを返す', () => {
    const products = [
      makeProduct('p1', { ebay_brand: 'Nintendo' }),
      makeProduct('p2', { ebay_brand: 'Generic' }),
    ]
    expect(findVeroProductIds(products, ['Nintendo'])).toEqual(['p1'])
  })
})

describe('価格タイプ除外判定', () => {
  it('オークションだけを抽出する', () => {
    const products = [
      makeProduct('p1', { price_type: 'fixed' }),
      makeProduct('p2', { price_type: 'auction' }),
    ]
    expect(findPriceTypeProductIds(products, ['auction'])).toEqual(['p2'])
  })

  it('固定価格とオークションの両方を抽出できる', () => {
    const products = [
      makeProduct('p1', { price_type: 'fixed' }),
      makeProduct('p2', { price_type: 'auction' }),
    ]
    expect(findPriceTypeProductIds(products, ['fixed', 'auction'])).toEqual(['p1', 'p2'])
  })

  it('価格タイプがない旧データは固定価格として扱う', () => {
    const product = makeProduct('p1')
    delete (product as Partial<Product>).price_type
    expect(getProductPriceType(product)).toBe('fixed')
  })

  it('未選択なら何も除外しない', () => {
    expect(findPriceTypeProductIds([makeProduct('p1')], [])).toEqual([])
  })
})

describe('除外対象件数の事前判定', () => {
  const products = [
    makeProduct('p1', {
      source_url: 'https://jp.mercari.com/user/profile/123/items/p1?tracking=1',
      source_seller_id: '123',
      source_seller_url: 'https://jp.mercari.com/user/profile/123',
      original_title: 'ジャンク Nintendo 本体',
      original_price: 500,
      ebay_price: 10,
      seller_rating_count: 3,
      shipping_days: 4,
      source_updated_at: '2025-01-01T00:00:00.000Z',
    }),
    makeProduct('p2', {
      source_url: 'https://jp.mercari.com/item/p2',
      original_title: '通常商品',
      original_price: 3000,
      ebay_price: 30,
      seller_rating_count: 100,
      shipping_days: 1,
      source_updated_at: '2026-06-01T00:00:00.000Z',
    }),
  ]

  it('危険セラーURLに一致する商品を数える', () => {
    expect(findDangerSellerProductIds(
      products,
      ['https://jp.mercari.com/user/profile/123'],
    )).toEqual(['p1'])
  })

  it('危険単語・スポット文字・簡易除外のタイトル一致を数える', () => {
    expect(findTitleKeywordProductIds(products, ['ジャンク'])).toEqual(['p1'])
    expect(findTitleKeywordProductIds(products, ['NINTENDO'])).toEqual(['p1'])
    expect(findTitleKeywordProductIds(products, [])).toEqual([])
  })

  it('個別商品詳細の説明文に含まれる危険単語も数える', () => {
    const detailed = [
      makeProduct('p3', {
        original_title: '通常商品',
        original_description: '説明欄にジャンクの記載があります',
      }),
    ]
    expect(findTitleKeywordProductIds(detailed, ['ジャンク'])).toEqual(['p3'])
  })

  it('価格範囲外の商品を数える', () => {
    expect(findPriceRangeProductIds(products, 'original', 1000, 4000)).toEqual(['p1'])
    expect(findPriceRangeProductIds(products, 'ebay', null, 20)).toEqual(['p2'])
  })

  it('評価数・発送日数の条件に一致する商品を数える', () => {
    expect(findSellerRatingProductIds(products, 10)).toEqual(['p1'])
    expect(findShippingDaysProductIds(products, 2)).toEqual(['p1'])
  })

  it('最終更新月の条件に一致する商品を数える', () => {
    expect(findUpdatedAtProductIds(
      products,
      3,
      new Date('2026-07-29T00:00:00.000Z'),
    )).toEqual(['p1'])
  })

  it('未入力・不正条件は0件として扱う', () => {
    expect(findPriceRangeProductIds(products, 'original', null, null)).toEqual([])
    expect(findSellerRatingProductIds(products, null)).toEqual([])
    expect(findShippingDaysProductIds(products, 0)).toEqual([])
    expect(findUpdatedAtProductIds(products, 0)).toEqual([])
  })
})
