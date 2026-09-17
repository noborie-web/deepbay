import { describe, expect, it } from 'vitest'
import { renderDescriptionTemplate } from '@/lib/html-template'
import { listingDescription } from '@/lib/listing-export'
import type { Product } from '@/types/database'

// 実データで確認した不具合: 抽出設定「HTML設定」のテンプレートは
// extraction_settings.html_template_id 列が無く一度も適用されていなかった。
// また抽出時に適用する設計だと、出力時のエスケープでHTMLタグが文字として
// 表示される。出力時にテンプレートを適用する。
function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', user_id: 'u1', extraction_id: 'e1',
    source_url: 'https://jp.mercari.com/item/m1', source_site: 'mercari', source_item_id: 'm1',
    original_title: '王の顔 韓国盤', original_price: 47000, original_description: '韓国盤',
    original_images: ['https://img/1.jpg', 'https://img/2.jpg'], original_condition: '新品',
    ebay_title: "The King's Face Korean Edition OST", ebay_brand: null, ebay_price: 649.02,
    ebay_description: 'Brand new & sealed.\nKorean edition with photobook.',
    ebay_images: ['https://img/1.jpg', 'https://img/2.jpg'], ebay_item_specifics: {},
    ebay_condition: 'New', ebay_category_id: null, listing_status: 'draft', listed_at: null, sold_at: null,
    seller_rating_count: null, seller_url: null, shipping_days: null, source_updated_at: null,
    raw_source_data: null, purchase_price_jpy: null, price_type: 'fixed',
    created_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-17T00:00:00Z',
    ...overrides,
  } as Product
}

describe('renderDescriptionTemplate', () => {
  it('テンプレートの変数を商品の値で置き換え、本文の改行は <br>、HTML特殊文字はエスケープする', () => {
    const html = renderDescriptionTemplate(
      '<div class="t"><h1>{{title}}</h1><p>{{description}}</p><p>{{condition}} {{price}}</p>{{images}}<img src="{{image2}}"></div>',
      product(),
    )
    expect(html).toContain("<h1>The King's Face Korean Edition OST</h1>")
    expect(html).toContain('<p>Brand new &amp; sealed.<br>Korean edition with photobook.</p>')
    expect(html).toContain('<p>New ¥47,000</p>')
    expect(html).toContain('<img src="https://img/1.jpg"')
    expect(html).toContain('<img src="https://img/2.jpg">')
  })
})

describe('listingDescription with template', () => {
  it('テンプレートがあればそれで組み立て、無ければ既定の Description/Shipping 構成にする', () => {
    const withTemplate = listingDescription(product(), '<section>{{description}}</section>')
    expect(withTemplate).toBe('<section>Brand new &amp; sealed.<br>Korean edition with photobook.</section>')
    const withoutTemplate = listingDescription(product(), null)
    expect(withoutTemplate).toContain('<h2>Description</h2>')
    expect(withoutTemplate).toContain('<h2>Shipping</h2>')
  })
})

import { dedupeItemSpecificColumns, ebayUploadColumnCount, generateListingCsv } from '@/lib/listing-export'

// 実データで確認した不具合: カテゴリ69528の出品CSVで C:Brand 列が2つ出力
// されていた(基本列とカテゴリ別項目の両方に Brand があるため)。
describe('dedupeItemSpecificColumns', () => {
  it('基本列にある Brand/Country と重複する項目を除き、同名の重複も1つにする', () => {
    expect(dedupeItemSpecificColumns(['Franchise', 'Brand', 'Country', 'Type', 'Type'])).toEqual(['Franchise', 'Type'])
    expect(ebayUploadColumnCount(['Franchise', 'Brand'])).toBe(ebayUploadColumnCount(['Franchise']))
  })

  it('出品CSVのヘッダーに C:Brand が1列しか出ない', () => {
    const csv = generateListingCsv([product()], {
      categoryId: '69528', sellerId: 'miyabi-24',
      paymentProfileName: 'p', returnProfileName: 'r', shippingProfileName: 's',
    }, ['Franchise', 'Brand', 'Type'])
    const header = csv.split('\n')[0]
    expect(header.split(',').filter((h) => h === 'C:Brand')).toHaveLength(1)
    expect(header).toContain('C:Franchise')
  })
})
