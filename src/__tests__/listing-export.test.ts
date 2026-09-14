import { describe, expect, it } from 'vitest'
import {
  EBAY_UPLOAD_COLUMN_COUNT,
  generateListingCsv,
  generateSpecificsCsv,
  getListingIssues,
  productCustomLabel,
  SPECIFICS_IN_COLUMN_COUNT,
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
    seller_url: null,
    raw_source_data: null,
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

function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const text = csv.replace(/^\uFEFF/, '')

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
    } else {
      field += char
    }
  }
  row.push(field)
  rows.push(row)
  return rows
}

describe('listing export', () => {
  it('編集済みeBay価格をUSDとしてそのままCSVへ出力する', () => {
    const csv = generateListingCsv([makeProduct()], OPTIONS)
    expect(csv).toContain(',83.00,5000,Tamiya Mini 4WD,')
    expect(csv).not.toContain('0.56')
    expect(csv).toContain(',eBay Payments,Returns Accepted,Japan Shipping,')
  })

  it('eBay添付見本と同じ42列を同じ順序で出力する', () => {
    const csv = generateListingCsv([makeProduct()], OPTIONS)
    const rows = parseCsv(csv)
    expect(EBAY_UPLOAD_COLUMN_COUNT).toBe(42)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.length === EBAY_UPLOAD_COLUMN_COUNT)).toBe(true)
    expect(rows[0].slice(0, 26)).toEqual([
      'Action(CC=Cp1252)',
      'CustomLabel',
      'StartPrice',
      'ConditionID',
      'Title',
      'Description',
      'C:Brand',
      'PicURL',
      'UPC',
      'Category',
      'PayPalAccepted',
      'PayPalEmailAddress',
      'PaymentProfileName',
      'ReturnProfileName',
      'ShippingProfileName',
      'Country',
      'Location',
      'Apply Profile Domestic',
      'Apply Profile International',
      'BuyerRequirements:LinkedPayPalAccount',
      'Duration',
      'Format',
      'Quantity',
      'Currency',
      'SiteID',
      'C:Country',
    ])
    expect(rows[0].at(-1)).toBe('C:Video Game Series')
    expect(rows[1][rows[0].indexOf('C:Brand')]).toBe('Tamiya')
    expect(rows[1][rows[0].indexOf('Description')]).toMatch(/^<!\[CDATA\[[\s\S]*\]\]>$/)
    expect(rows[1][rows[0].indexOf('C:Platform')]).toBe('NA')
  })

  it('eBay出品CSVのPicURLへ最大24枚をパイプ区切りで出力する', () => {
    const images = Array.from(
      { length: 25 },
      (_, index) => `https://static.mercdn.net/item/detail/orig/photos/m1_${index + 1}.jpg`,
    )
    const rows = parseCsv(generateListingCsv([
      makeProduct({ ebay_images: images }),
    ], OPTIONS))
    expect(rows[1][rows[0].indexOf('PicURL')]).toBe(images.slice(0, 24).join('|'))
  })

  it('メルカリのオリジナル画像がある場合は重複サムネイルを除外する', () => {
    const originals = [
      'https://static.mercdn.net/item/detail/orig/photos/m1_1.jpg?1',
      'https://static.mercdn.net/item/detail/orig/photos/m1_2.jpg?2',
    ]
    const rows = parseCsv(generateListingCsv([
      makeProduct({
        ebay_images: [
          ...originals,
          'https://static.mercdn.net/thumb/item/jpeg/m1_1.jpg?1',
        ],
      }),
    ], OPTIONS))
    expect(rows[1][rows[0].indexOf('PicURL')]).toBe(originals.join('|'))
  })

  it('Specifics-IN CSVは添付互換の出品列と日本語元データ列を持つ', () => {
    const product = makeProduct()
    const csv = generateSpecificsCsv([product], OPTIONS)
    const header = csv.split('\r\n')[0]
    expect(csv).toContain(productCustomLabel(product))
    expect(header).toContain('Action(CC=Cp1252),CustomLabel,StartPrice,ConditionID,Title,Description,C:Brand,PicURL,UPC,Category')
    expect(header).toContain('C:Country,jp_desc,jp_title,jp_spec')
    expect(header).toContain('C:Video Game Series')
    expect(csv).toContain(',Original description,Original title,')
    expect(csv).toContain(',eBay Payments,Returns Accepted,Japan Shipping,')
  })

  // ユーザー要望: specifics-in(外部ツール)がjp_spec列の内容からカテゴリ
  // 別のItem Specificsを自動生成しているため、公式ツールと同様に仕入元
  // サイトの生データ(カテゴリ階層・出品者情報など)をそのまま出力したい。
  // これまでは数フィールドだけの簡易オブジェクトしか出力しておらず、
  // specifics-inがカテゴリを判別できず誤ったフィールドセットを生成する
  // 原因になっていた。
  // ユーザー要望: Item Specifics(C:列)が全カテゴリ共通の固定リスト
  // (ゲーム向け)にハードコードされており、音楽CD等の別カテゴリで
  // 必要な項目(Artist, Record Label等)が出力されなかった。呼び出し側
  // (eBay Taxonomy APIから取得したカテゴリ別項目名)を渡せるようにした。
  describe('カテゴリ別のItem Specifics列(itemSpecificColumns引数)', () => {
    it('itemSpecificColumnsを渡すと、そのカテゴリ専用の項目名でC:列を生成する', () => {
      const cdColumns = ['Artist', 'Record Label', 'CD Grading']
      const product = makeProduct({
        ebay_item_specifics: { Artist: ['X JAPAN'], 'Record Label': ['Sony Music'] },
      })
      const csv = generateSpecificsCsv([product], OPTIONS, cdColumns)
      const rows = parseCsv(csv)
      expect(rows[0]).toEqual(expect.arrayContaining(['C:Artist', 'C:Record Label', 'C:CD Grading']))
      expect(rows[0]).not.toContain('C:Game Name')
      expect(rows[1][rows[0].indexOf('C:Artist')]).toBe('X JAPAN')
      expect(rows[1][rows[0].indexOf('C:Record Label')]).toBe('Sony Music')
      expect(rows[1][rows[0].indexOf('C:CD Grading')]).toBe('NA')
    })

    it('itemSpecificColumnsを省略すると、従来通り固定リスト(ゲーム向け)を使う', () => {
      const csv = generateSpecificsCsv([makeProduct()], OPTIONS)
      const header = csv.split('\r\n')[0]
      expect(header).toContain('C:Game Name')
      expect(header).toContain('C:Video Game Series')
    })

    it('generateListingCsvでも同様にitemSpecificColumnsを反映する', () => {
      const csv = generateListingCsv([makeProduct()], OPTIONS, ['Artist', 'Record Label'])
      const header = csv.split('\r\n')[0]
      expect(header).toContain('C:Artist')
      expect(header).toContain('C:Record Label')
      expect(header).not.toContain('C:Game Name')
    })
  })

  it('raw_source_dataがあればjp_spec列にそのまま出力する(specifics-inのカテゴリ判定用)', () => {
    const rawSourceData = {
      id: 'm1',
      item_category: { name: '邦楽', parent_category_name: 'CD', root_category_name: 'CD・DVD・ブルーレイ' },
      seller: { name: 'テストセラー', num_ratings: 100 },
    }
    const product = makeProduct({ raw_source_data: rawSourceData })
    const csv = generateSpecificsCsv([product], OPTIONS)
    const rows = parseCsv(csv)
    const jpSpec = rows[1][rows[0].indexOf('jp_spec')]
    expect(JSON.parse(jpSpec)).toEqual(rawSourceData)
  })

  it('raw_source_dataが無い商品は従来通りの簡易スナップショットにフォールバックする', () => {
    const product = makeProduct({ raw_source_data: null })
    const csv = generateSpecificsCsv([product], OPTIONS)
    const rows = parseCsv(csv)
    const jpSpec = JSON.parse(rows[1][rows[0].indexOf('jp_spec')])
    expect(jpSpec).toMatchObject({
      id: product.source_item_id,
      url: product.source_url,
      site: product.source_site,
      title: product.original_title,
    })
    expect(jpSpec.item_category).toBeUndefined()
  })

  it('PicURLへ全画像をパイプ区切りで出力する', () => {
    const images = [
      'https://static.mercdn.net/item/detail/orig/photos/m1_1.jpg?1',
      'https://static.mercdn.net/item/detail/orig/photos/m1_2.jpg?2',
      'https://static.mercdn.net/item/detail/orig/photos/m1_3.jpg?3',
    ]
    const csv = generateSpecificsCsv([
      makeProduct({ ebay_images: images, original_images: images }),
    ], OPTIONS)
    expect(csv).toContain(images.join('|'))
  })

  it('編集画像が空なら元の全画像をPicURLへ出力する', () => {
    const images = [
      'https://static.mercdn.net/item/detail/orig/photos/m1_1.jpg?1',
      'https://static.mercdn.net/item/detail/orig/photos/m1_2.jpg?2',
    ]
    const csv = generateSpecificsCsv([
      makeProduct({ ebay_images: [], original_images: images }),
    ], OPTIONS)
    expect(csv).toContain(images.join('|'))
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

  it('商品項目やカテゴリに左右されず全行を必ず45列で出力する', () => {
    const csv = generateSpecificsCsv([
      makeProduct({
        ebay_item_specifics: {
          Material: ['Plastic'],
          Platform: ['Nintendo GameCube'],
        },
      }),
      makeProduct({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        ebay_item_specifics: {},
      }),
    ], { ...OPTIONS, categoryId: null })
    const rows = parseCsv(csv)
    expect(SPECIFICS_IN_COLUMN_COUNT).toBe(45)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.length === SPECIFICS_IN_COLUMN_COUNT)).toBe(true)
    expect(rows[0]).toContain('C:California Prop 65 Warning')
    expect(rows[0]).toContain('C:Video Game Series')
    expect(rows[0]).not.toContain('C:Material')
    expect(rows[1][rows[0].indexOf('C:Platform')]).toBe('Nintendo GameCube')
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

// 実データで確認した不具合: eBayのConditionIDはカテゴリごとに有効な値が
// 異なる。CDカテゴリ(176984)へアップロードしたところ、ConditionID=3000
// (Used)の138件が全て "The provided condition id is invalid for the
// selected primary category id.|3000|CDs|CONDITION_ID|" で失敗した。
// 出品カテゴリー管理画面でカテゴリごとに設定したマッピングを使えるようにする。
describe('カテゴリー別ConditionIDマッピング', () => {
  const MEDIA_MAP = { '中古': '5000', '未使用に近い': '2750', '新品、未使用': '2750' }
  const CONDITION_COLUMN = 3

  it('カテゴリー別設定があれば出品CSVのConditionIDにそれを使う', () => {
    const csv = generateListingCsv(
      [makeProduct({ ebay_condition: '中古' })],
      { ...OPTIONS, categoryId: '176984', conditionMap: MEDIA_MAP },
    )
    expect(parseCsv(csv)[1][CONDITION_COLUMN]).toBe('5000')
  })

  it('カテゴリー別設定が無ければ従来の標準マッピングを使う', () => {
    const csv = generateListingCsv(
      [makeProduct({ ebay_condition: '中古' })],
      { ...OPTIONS, categoryId: '176984' },
    )
    expect(parseCsv(csv)[1][CONDITION_COLUMN]).toBe('3000')
  })

  it('specifics-in用CSVでもカテゴリー別設定を反映する(従来は固定マップを直接参照しており、カテゴリ別ルールが効かない不具合があった)', () => {
    const csv = generateSpecificsCsv(
      [makeProduct({ ebay_condition: '中古' })],
      { ...OPTIONS, categoryId: '176984', conditionMap: MEDIA_MAP },
    )
    expect(parseCsv(csv)[1][CONDITION_COLUMN]).toBe('5000')
  })

  it('specifics-in用CSVでもVideo Games(139973)の従来ルールが効く', () => {
    const csv = generateSpecificsCsv([makeProduct({ ebay_condition: '中古' })], OPTIONS)
    expect(parseCsv(csv)[1][CONDITION_COLUMN]).toBe('5000')
  })

  it('スクレイパー由来の状態(メルカリ表記)にもカテゴリー別設定が効く', () => {
    const csv = generateListingCsv(
      [makeProduct({ ebay_condition: null, original_condition: '新品、未使用' })],
      { ...OPTIONS, categoryId: '176984', conditionMap: MEDIA_MAP },
    )
    // 知的財産警告を避けるため新品(1000)ではなくLike New(2750)を使える
    expect(parseCsv(csv)[1][CONDITION_COLUMN]).toBe('2750')
  })

  it('設定に無い状態は従来のマッピングにフォールバックする', () => {
    const csv = generateListingCsv(
      [makeProduct({ ebay_condition: 'ジャンク' })],
      { ...OPTIONS, categoryId: '176984', conditionMap: MEDIA_MAP },
    )
    expect(parseCsv(csv)[1][CONDITION_COLUMN]).toBe('7000')
  })
})
