import { describe, expect, it } from 'vitest'
import {
  generateListingCsv,
  generateSpecificsCsv,
  getListingIssues,
  productCustomLabel,
  specificsInFilename,
} from '@/lib/listing-export'
import type { Product } from '@/types/database'

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: 'https://example.com/item/1',
    source_site: 'mercari',
    source_item_id: '1',
    original_title: 'Original title',
    original_price: 6000,
    original_description: 'Original description',
    original_images: ['https://img.example/original.jpg'],
    original_condition: '中古',
    ebay_title: 'Tamiya Mini 4WD',
    ebay_brand: 'Tamiya',
    ebay_price: 83,
    ebay_description: 'Line 1\nLine 2',
    ebay_images: ['https://img.example/1.jpg'],
    ebay_item_specifics: { Material: ['Plastic'] },
    ebay_condition: '中古',
    ebay_category_id: null,
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
  sellerId: 'miyabi-24',
  paymentProfileName: 'eBay Payments',
  returnProfileName: 'Returns Accepted',
  shippingProfileName: 'Japan Shipping',
}

describe('listing export', () => {
  it('編集済みeBay価格をUSDとしてそのままCSVへ出力する', () => {
    const csv = generateListingCsv([makeProduct()], OPTIONS)
    expect(csv).toContain(',83.00,3000,Tamiya Mini 4WD,')
    expect(csv).not.toContain('0.56')
    expect(csv).toContain(',eBay Payments,Returns Accepted,Japan Shipping,')
  })

  it('ブランドと商品項目を動的なC列へ出力する', () => {
    const csv = generateListingCsv([makeProduct()], OPTIONS)
    expect(csv.split('\r\n')[0]).toContain('C:Brand,C:Material')
    expect(csv).toContain(',Tamiya,Plastic')
  })

  it('Specifics-IN CSVは添付互換の出品列と日本語元データ列を持つ', () => {
    const product = makeProduct()
    const csv = generateSpecificsCsv([product], OPTIONS)
    const header = csv.split('\r\n')[0]
    expect(csv).toContain(productCustomLabel(product))
    expect(header).toContain('Action(CC=Cp1252),CustomLabel,StartPrice,ConditionID,Title,Description,C:Brand,PicURL,UPC,Category')
    expect(header).toContain('C:Country,jp_desc,jp_title,jp_spec')
    expect(header).toContain('C:Material')
    expect(csv).toContain(',Original description,Original title,')
    expect(csv).toContain(',eBay Payments,Returns Accepted,Japan Shipping,')
  })

  it('Specifics-IN CSVは空のSpecifics値をNAとして出力する', () => {
    const csv = generateSpecificsCsv([
      makeProduct({ ebay_item_specifics: { Material: ['Plastic'] } }),
      makeProduct({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        ebay_item_specifics: {},
      }),
    ], OPTIONS)
    expect(csv.split('\r\n')[2]).toContain(',NA')
  })

  it('カテゴリ139973では見本と同じ45列を常に出力する', () => {
    const csv = generateSpecificsCsv([
      makeProduct({ ebay_item_specifics: {} }),
    ], OPTIONS)
    const [header, row] = csv.split('\r\n')
    expect(header.split(',')).toHaveLength(45)
    expect(header).toContain('C:California Prop 65 Warning')
    expect(header).toContain('C:Video Game Series')
    expect(row.endsWith(',NA')).toBe(true)
  })

  it('Specifics-IN互換のファイル名を生成する', () => {
    expect(specificsInFilename(
      'miyabi-24',
      '139973',
      '4ad735a4-bb62-4343-81ab-d4189474eb0e',
    )).toBe('miyabi-24_139973_4ad735a4_bb62_4343_81ab_d4189474eb0e.csv')
  })

  it('出品に必要なタイトル・価格・画像・カテゴリの不足を返す', () => {
    const product = makeProduct({
      ebay_title: null,
      ebay_price: null,
      ebay_images: [],
      ebay_category_id: null,
    })
    expect(getListingIssues(product, null)).toEqual(['タイトル', '価格', '画像', 'カテゴリ'])
  })

  it('抽出カテゴリがあれば商品カテゴリ未設定でも出品可能', () => {
    expect(getListingIssues(makeProduct({ ebay_category_id: null }), '139973')).toEqual([])
  })
})
