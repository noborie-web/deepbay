import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRODUCT_SEARCH_FILTERS,
  filterProducts,
} from '@/lib/product-search'
import type { Product } from '@/types/database'

function makeProduct(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: `https://example.com/${id}`,
    source_site: 'mercari',
    source_item_id: id,
    original_title: `Original ${id}`,
    original_price: 3000,
    original_description: null,
    original_images: [],
    original_condition: '中古',
    ebay_title: `eBay ${id}`,
    ebay_brand: null,
    ebay_price: null,
    ebay_description: null,
    ebay_images: [],
    ebay_item_specifics: {},
    ebay_condition: '中古',
    ebay_category_id: null,
    listing_status: 'draft',
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: null,
    price_type: 'fixed',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
    ...overrides,
  }
}

const products = [
  makeProduct('p1', {
    original_title: 'タミヤ ミニ四駆',
    ebay_title: 'Tamiya Mini 4WD',
    ebay_brand: 'Tamiya',
    ebay_price: 45,
    purchase_price_jpy: 5000,
    ebay_item_specifics: { Material: ['Plastic'] },
  }),
  makeProduct('p2', {
    source_site: 'snkrdunk',
    original_title: 'Nike Air Jordan',
    ebay_title: 'Nike Sneakers',
    ebay_condition: '新品',
    ebay_price: null,
    original_price: 12000,
    price_type: 'auction',
  }),
]

describe('filterProducts', () => {
  it('空の条件では全商品を返す', () => {
    expect(filterProducts(products, DEFAULT_PRODUCT_SEARCH_FILTERS)).toHaveLength(2)
  })

  it('複数キーワードをAND検索し、表記揺れを正規化する', () => {
    const result = filterProducts(products, {
      ...DEFAULT_PRODUCT_SEARCH_FILTERS,
      query: 'ＴＡＭＩＹＡ plastic',
    })
    expect(result.map((product) => product.id)).toEqual(['p1'])
  })

  it('商品IDとURLも検索対象にする', () => {
    expect(filterProducts(products, {
      ...DEFAULT_PRODUCT_SEARCH_FILTERS,
      query: 'p2',
    }).map((product) => product.id)).toEqual(['p2'])
  })

  it('サイト・状態・価格タイプを組み合わせて絞り込む', () => {
    expect(filterProducts(products, {
      ...DEFAULT_PRODUCT_SEARCH_FILTERS,
      sourceSite: 'snkrdunk',
      condition: '新品',
      priceType: 'auction',
    }).map((product) => product.id)).toEqual(['p2'])
  })

  it('eBay価格の設定済み・未設定を絞り込む', () => {
    expect(filterProducts(products, {
      ...DEFAULT_PRODUCT_SEARCH_FILTERS,
      priceState: 'set',
    }).map((product) => product.id)).toEqual(['p1'])
    expect(filterProducts(products, {
      ...DEFAULT_PRODUCT_SEARCH_FILTERS,
      priceState: 'unset',
    }).map((product) => product.id)).toEqual(['p2'])
  })

  it('仕入価格の範囲をpurchase_price_jpy優先で判定する', () => {
    expect(filterProducts(products, {
      ...DEFAULT_PRODUCT_SEARCH_FILTERS,
      priceMin: '4500',
      priceMax: '5500',
    }).map((product) => product.id)).toEqual(['p1'])
  })

  it('eBay価格範囲では未設定商品を除外する', () => {
    expect(filterProducts(products, {
      ...DEFAULT_PRODUCT_SEARCH_FILTERS,
      priceTarget: 'ebay',
      priceMin: '40',
      priceMax: '50',
    }).map((product) => product.id)).toEqual(['p1'])
  })
})
