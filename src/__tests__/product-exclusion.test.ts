import { describe, expect, it } from 'vitest'
import type { Product } from '@/types/database'
import {
  findDangerSellerProductIds,
  findKeywordProductIds,
  findLowRatingProductIds,
  findPriceRangeProductIds,
  findPriceTypeProductIds,
  findSlowShippingProductIds,
  findStaleProductIds,
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

// これらのヘルパーは除外「実行」時と、実行前の対象件数プレビュー表示
// (ProductEditPanel)の両方から呼ばれる共通ロジック。
describe('キーワード除外判定(スポット文字・簡易除外・危険単語で共有)', () => {
  it('タイトルにキーワードを含む商品を大文字小文字を区別せず抽出する', () => {
    const products = [
      makeProduct('p1', { original_title: 'ジャンク品 ラジコン' }),
      makeProduct('p2', { original_title: '美品 ラジコン' }),
    ]
    expect(findKeywordProductIds(products, ['ジャンク'])).toEqual(['p1'])
  })

  it('キーワードが空なら何も除外しない', () => {
    expect(findKeywordProductIds([makeProduct('p1')], [])).toEqual([])
  })

  it('fieldsを指定するとブランド・商品詳細も判定対象にできる(既存ツールとの機能監査で追加)', () => {
    const products = [
      makeProduct('p1', { original_title: '普通', ebay_brand: 'RiskyBrand', ebay_description: '普通の説明' }),
      makeProduct('p2', { original_title: '普通', ebay_brand: 'SafeBrand', ebay_description: '危険ワードABCDを含む説明' }),
      makeProduct('p3', { original_title: '普通', ebay_brand: 'SafeBrand', ebay_description: '普通の説明' }),
    ]
    expect(findKeywordProductIds(products, ['RiskyBrand'], ['title', 'brand', 'description'])).toEqual(['p1'])
    expect(findKeywordProductIds(products, ['ABCD'], ['title', 'brand', 'description'])).toEqual(['p2'])
  })

  it('デフォルト(fields未指定)はタイトルのみを判定し、ブランド一致は対象にしない(スポット文字・簡易除外の既存挙動を維持)', () => {
    const products = [makeProduct('p1', { original_title: '普通', ebay_brand: 'DangerBrand' })]
    expect(findKeywordProductIds(products, ['DangerBrand'])).toEqual([])
  })

  it('fieldsを空配列で指定すると何も除外しない', () => {
    const products = [makeProduct('p1', { original_title: 'ジャンク' })]
    expect(findKeywordProductIds(products, ['ジャンク'], [])).toEqual([])
  })
})

describe('危険セラー除外判定', () => {
  it('セラーURLの前方一致で商品を抽出する(クエリパラメータ・末尾スラッシュは無視)', () => {
    const products = [
      makeProduct('p1', { source_url: 'https://jp.mercari.com/user/profile/123?ref=x' }),
      makeProduct('p2', { source_url: 'https://jp.mercari.com/user/profile/999' }),
    ]
    expect(findDangerSellerProductIds(products, ['https://jp.mercari.com/user/profile/123/'])).toEqual(['p1'])
  })

  it('セラーURL未設定なら何も除外しない', () => {
    expect(findDangerSellerProductIds([makeProduct('p1')], [])).toEqual([])
  })
})

describe('価格範囲除外判定', () => {
  it('最小値未満・最大値超過の商品を除外対象にする', () => {
    const products = [
      makeProduct('p1', { original_price: 500 }),
      makeProduct('p2', { original_price: 5000 }),
      makeProduct('p3', { original_price: 50000 }),
    ]
    expect(findPriceRangeProductIds(products, 1000, 10000, 'original')).toEqual(['p1', 'p3'])
  })

  it('最小・最大どちらも未指定なら何も除外しない', () => {
    expect(findPriceRangeProductIds([makeProduct('p1')], null, null, 'original')).toEqual([])
  })

  it('eBay価格を対象にできる', () => {
    const products = [makeProduct('p1', { ebay_price: 5 }), makeProduct('p2', { ebay_price: 50 })]
    expect(findPriceRangeProductIds(products, 10, null, 'ebay')).toEqual(['p1'])
  })
})

describe('評価数・発送日数・最終更新月の除外判定', () => {
  it('評価数がN件以下の商品を抽出する(nullは対象外)', () => {
    const products = [
      makeProduct('p1', { seller_rating_count: 3 }),
      makeProduct('p2', { seller_rating_count: 50 }),
      makeProduct('p3', { seller_rating_count: null }),
    ]
    expect(findLowRatingProductIds(products, 5)).toEqual(['p1'])
  })

  it('発送日数がN日を超える商品を抽出する', () => {
    const products = [
      makeProduct('p1', { shipping_days: 1 }),
      makeProduct('p2', { shipping_days: 10 }),
    ]
    expect(findSlowShippingProductIds(products, 3)).toEqual(['p2'])
  })

  it('指定月数より前に更新された商品を抽出する', () => {
    const old = new Date()
    old.setMonth(old.getMonth() - 6)
    const recent = new Date()
    const products = [
      makeProduct('p1', { source_updated_at: old.toISOString() }),
      makeProduct('p2', { source_updated_at: recent.toISOString() }),
      makeProduct('p3', { source_updated_at: null }),
    ]
    expect(findStaleProductIds(products, 3)).toEqual(['p1'])
  })
})
