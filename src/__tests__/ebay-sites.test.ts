import { describe, expect, it } from 'vitest'
import { convertListingPrice, EBAY_SITES, normalizeSiteKeys, tradingSiteIdFor } from '@/lib/ebay-sites'
import { generateListingCsv, generateSpecificsCsv, listingFilename, listingPriceForSite, specificsInFilename } from '@/lib/listing-export'
import { sitePriceAdjustment } from '@/lib/inventory-pricing'
import type { Product } from '@/types/database'

// ユーザー要望(2026-09-25): US に加えて UK・AU にも直接アップロードしたい。
// SiteID / Currency / StartPrice をサイトごとに切り替えた3ファイルを出力する。
function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', user_id: 'u1', extraction_id: 'e1',
    source_url: 'https://jp.mercari.com/item/m1', source_site: 'mercari', source_item_id: 'm1',
    original_title: '元タイトル', original_price: 5000, original_description: '', original_images: ['https://img/1.jpg'],
    original_condition: '中古', ebay_title: 'Title', ebay_brand: 'BrandX', ebay_price: 135.14,
    ebay_description: 'desc', ebay_images: ['https://img/1.jpg'], ebay_item_specifics: {}, ebay_condition: '中古',
    ebay_category_id: '176984', listing_status: 'draft', listed_at: null, sold_at: null,
    seller_rating_count: null, seller_url: null, raw_source_data: null, shipping_days: null,
    source_updated_at: null, purchase_price_jpy: 5000, price_type: 'fixed',
    pricing_jpy_per_usd: 157, ebay_item_id: null,
    created_at: '', updated_at: '',
    ...overrides,
  } as Product
}

describe('ebay-sites', () => {
  it('サイトごとの SiteID / Currency / Trading API の SiteID', () => {
    expect(EBAY_SITES.US).toMatchObject({ siteId: 'US', currency: 'USD', tradingSiteId: '0' })
    expect(EBAY_SITES.UK).toMatchObject({ siteId: 'UK', currency: 'GBP', tradingSiteId: '3' })
    expect(EBAY_SITES.AU).toMatchObject({ siteId: 'AU', currency: 'AUD', tradingSiteId: '15' })
    expect(tradingSiteIdFor('UK')).toBe('3')
    expect(tradingSiteIdFor(null)).toBe('0')
  })

  it('sites パラメータを正規化する(不正値はUSにフォールバック)', () => {
    expect(normalizeSiteKeys('US,UK,AU')).toEqual(['US', 'UK', 'AU'])
    expect(normalizeSiteKeys('uk')).toEqual(['UK'])
    expect(normalizeSiteKeys('XX')).toEqual(['US'])
    expect(normalizeSiteKeys(null)).toEqual(['US'])
  })

  it('円換算した価値を保ったまま別通貨に換算する', () => {
    // $135.14(出品時 157円/USD) = ¥21,217 → GBP(210円/GBP)で £101.03
    expect(convertListingPrice(135.14, 157, 210)).toBeCloseTo(101.04, 2)
    // AUD(111.53円/AUD)で A$190.24
    expect(convertListingPrice(135.14, 157, 111.53)).toBeCloseTo(190.24, 2)
    expect(convertListingPrice(0, 157, 210)).toBeNull()
  })
})

describe('generateListingCsv: 出品先サイト', () => {
  const policies = { sellerId: 'miyabi-24', categoryId: '176984', paymentProfileName: 'pay', returnProfileName: 'ret', shippingProfileName: 'ship' }

  it('US は従来どおり USD / US で、価格は換算しない', () => {
    const csv = generateListingCsv([product()], policies)
    const row = csv.split('\n')[1]
    expect(row).toContain(',135.14,')
    expect(row).toMatch(/,USD,US,Japan,/)
  })

  it('UK は GBP / UK で、StartPrice を為替換算する', () => {
    const csv = generateListingCsv([product()], {
      ...policies,
      site: { siteId: 'UK', currency: 'GBP', jpyPerCurrency: 210, fallbackJpyPerUsd: 157 },
    })
    const row = csv.split('\n')[1]
    expect(row).toContain(',101.04,')
    // Currency / SiteID / C:Country(3サイト共通でJapan)
    expect(row).toMatch(/,GBP,UK,Japan,/)
  })

  it('出品時レートが無い商品は、渡された USD/JPY レートで換算する', () => {
    expect(listingPriceForSite(
      { ebay_price: 100, pricing_jpy_per_usd: null } as Product,
      { siteId: 'AU', currency: 'AUD', jpyPerCurrency: 111.53, fallbackJpyPerUsd: 150 },
    )).toBeCloseTo(134.50, 2)
  })

  it('複数サイトのときはファイル名にサイトを入れる', () => {
    expect(listingFilename('miyabi-24', 'listing', 'UK')).toMatch(/^ebay_listing_UK_miyabi-24_\d{8}\.csv$/)
    expect(listingFilename('miyabi-24', 'listing')).toMatch(/^ebay_listing_miyabi-24_\d{8}\.csv$/)
  })
})

// ユーザー要望(2026-09-26): 関税率13%は米国向けの設定なので、UK/AU出品では
// 適用しない(既定ON)。UK/AUの価格はその分だけ安くなる。
describe('US以外で関税率を適用しない設定', () => {
  const model = {
    kind: 'tiered' as const,
    tiers: [{ maxPurchaseJpy: null, profitJpy: 3000 }],
    ebayFeeRate: 0.15, shippingJpy: 6000, fixedCostUsd: 0,
    adRate: 0.04, customsRate: 0.13, discountRate: 0.05,
    skipCustomsOutsideUs: true,
  }

  it('USは補正しない', () => {
    expect(sitePriceAdjustment(model, 'US')).toBe(1)
    expect(sitePriceAdjustment(model, null)).toBe(1)
  })

  it('UK/AUは関税分だけ安くなる(0.63/0.76)', () => {
    expect(sitePriceAdjustment(model, 'UK')).toBeCloseTo(0.63 / 0.76, 6)
    expect(sitePriceAdjustment(model, 'AU')).toBeCloseTo(0.63 / 0.76, 6)
  })

  it('設定がOFF・関税率0・モデル無しなら補正しない', () => {
    expect(sitePriceAdjustment({ ...model, skipCustomsOutsideUs: false }, 'UK')).toBe(1)
    expect(sitePriceAdjustment({ ...model, customsRate: 0 }, 'UK')).toBe(1)
    expect(sitePriceAdjustment(null, 'UK')).toBe(1)
  })

  it('CSVの出品価格にも補正が反映される', () => {
    // 110USD × 157円 = 17,270円 → ÷210円/GBP = 82.24 → ×0.8289 = 68.18(切り上げ)
    const price = listingPriceForSite(
      { ebay_price: 110, pricing_jpy_per_usd: 157 },
      { siteId: 'UK', currency: 'GBP', jpyPerCurrency: 210, fallbackJpyPerUsd: 157, priceAdjustment: 0.63 / 0.76 },
    )
    expect(price).toBe(68.18)
  })
})

// 本番で確認した不具合(2026-09-26): 出品先にUK/AUを選んでも、Specifics-IN CSV
// だけ SiteID=US / Currency=USD / USD価格で出力され、そのままアップロードすると
// US向け出品になっていた。
describe('Specifics-IN CSVのサイト別出力', () => {
  const product = {
    id: '11111111-1111-4111-8111-111111111111',
    ebay_price: 110,
    pricing_jpy_per_usd: 157,
    original_title: 'テスト万年筆',
    ebay_title: 'Test Fountain Pen',
    ebay_category_id: '7281',
    original_description: '説明',
  } as unknown as Product

  // 説明文にカンマ・改行が入るため、Currency/SiteID は並び
  // (…GTC,Format,Quantity,Currency,SiteID…)を直接確認する
  it('サイトを指定しなければ従来どおり US / USD', () => {
    const csv = generateSpecificsCsv([product], {
      categoryId: '7281', sellerId: 'akebono-32',
      paymentProfileName: 'p', returnProfileName: 'r', shippingProfileName: 's',
    })
    expect(csv).toContain(',GTC,FixedPriceItem,1,USD,US,')
    expect(csv).toContain('Add,kakehashi_11111111_1111_4111_8111_111111111111,110.00,')
  })

  it('UKを指定するとSiteID・Currency・価格がUK向けになる', () => {
    const csv = generateSpecificsCsv([product], {
      categoryId: '7281', sellerId: 'akebono-32',
      paymentProfileName: 'p', returnProfileName: 'r', shippingProfileName: 's',
      site: { siteId: 'UK', currency: 'GBP', jpyPerCurrency: 210, fallbackJpyPerUsd: 157 },
    })
    expect(csv).toContain(',GTC,FixedPriceItem,1,GBP,UK,')
    expect(csv).toContain('Add,kakehashi_11111111_1111_4111_8111_111111111111,82.24,')
  })

  it('複数サイトのときはファイル名にサイトが入る', () => {
    expect(specificsInFilename('akebono-32', '7281', 'ext-1', 'UK'))
      .toBe('akebono-32_UK_7281_ext_1.csv')
    expect(specificsInFilename('akebono-32', '7281', 'ext-1'))
      .toBe('akebono-32_7281_ext_1.csv')
  })
})
