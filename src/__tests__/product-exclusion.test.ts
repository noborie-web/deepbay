import { describe, expect, it } from 'vitest'
import type { Product } from '@/types/database'
import {
  findPriceTypeProductIds,
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
