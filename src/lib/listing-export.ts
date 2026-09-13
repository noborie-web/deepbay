import type { Product } from '@/types/database'

export interface ListingPolicies {
  paymentProfileName: string
  returnProfileName: string
  shippingProfileName: string
}

export interface ListingExportOptions extends ListingPolicies {
  categoryId: string | null
  sellerId: string
}

const CONDITION_ID_MAP: Record<string, string> = {
  '新品': '1000',
  '新品、未使用': '1000',
  '新品同様': '1500',
  '未使用に近い': '1500',
  '良い': '2500',
  '目立った傷や汚れなし': '2500',
  '普通': '3000',
  '中古': '3000',
  'やや傷や汚れあり': '3000',
  '傷や汚れあり': '4000',
  'ジャンク': '7000',
  '全体的に状態が悪い': '7000',
}

const EBAY_UPLOAD_BASE_HEADERS = [
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
]

export const EBAY_UPLOAD_ITEM_SPECIFIC_COLUMNS = [
  'California Prop 65 Warning',
  'Country/Region of Manufacture',
  'Features',
  'Game Name',
  'Genre',
  'MPN',
  'Manufacturer Warranty',
  'Platform',
  'Publisher',
  'Rating',
  'Region Code',
  'Release Year',
  'Sub-Genre',
  'Unit Quantity',
  'Unit Type',
  'Video Game Series',
] as const

export const EBAY_UPLOAD_COLUMN_COUNT = 42

// 呼び出し側(APIルート)がレスポンスヘッダー等で実際の出力列数を知る
// ためのヘルパー(itemSpecificColumnsがカテゴリごとに変動するため)。
export function ebayUploadColumnCount(itemSpecificColumns: readonly string[]): number {
  return EBAY_UPLOAD_BASE_HEADERS.length + itemSpecificColumns.length
}

function escapeCsv(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'seller'
}

export function listingFilename(sellerId: string, kind: 'listing' | 'specifics'): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `ebay_${kind}_${normalizeFilenamePart(sellerId)}_${date}.csv`
}

export function specificsInFilename(
  sellerId: string,
  categoryId: string | null,
  extractionId: string,
): string {
  return [
    normalizeFilenamePart(sellerId),
    normalizeFilenamePart(categoryId ?? 'category'),
    normalizeFilenamePart(extractionId.replace(/-/g, '_')),
  ].join('_') + '.csv'
}

export function productCustomLabel(product: Pick<Product, 'id'>): string {
  return `kakehashi_${product.id.replace(/-/g, '_')}`
}

export function productSpecifics(product: Product): Record<string, string[]> {
  const specifics = { ...(product.ebay_item_specifics ?? {}) }
  if (product.ebay_brand?.trim() && !specifics.Brand?.length) {
    specifics.Brand = [product.ebay_brand.trim()]
  }
  return specifics
}

export function listingDescription(product: Product): string {
  const description = product.ebay_description ?? product.original_description ?? ''
  const condition = product.ebay_condition ?? product.original_condition ?? 'Pre-owned / Used'
  return [
    '<meta charset="utf-8">',
    '<div>',
    '<h2>Description</h2>',
    `<p>Condition: <strong>${escapeHtml(condition)}</strong></p>`,
    description ? `<p>${escapeHtml(description).replace(/\r?\n/g, '<br>')}</p>` : '',
    '<h2>Shipping</h2>',
    '<p>Shipping from Japan, Monday to Friday.</p>',
    '<h2>Import duties</h2>',
    '<p>Import duties, taxes, and charges are the buyer&apos;s responsibility.</p>',
    '</div>',
  ].join('')
}

function listingCsvDescription(product: Product): string {
  return `<![CDATA[${listingDescription(product).replace(/]]>/g, ']]&gt;')}]]>`
}

export function getListingIssues(product: Product, fallbackCategoryId: string | null): string[] {
  const issues: string[] = []
  const title = product.ebay_title?.trim()
  if (!title || title.length > 80) issues.push('タイトル')
  if (product.ebay_price == null || !Number.isFinite(Number(product.ebay_price)) || Number(product.ebay_price) <= 0) {
    issues.push('価格')
  }
  if (!(product.ebay_images ?? []).length) issues.push('画像')
  if (!(product.ebay_category_id ?? fallbackCategoryId)?.trim()) issues.push('カテゴリ')
  return issues
}

export function getDirectListingIssues(product: Product, fallbackCategoryId: string | null): string[] {
  const issues = getListingIssues(product, fallbackCategoryId)
  if (product.price_type === 'auction') issues.push('オークション形式')
  return issues
}

export function conditionIdForProduct(product: Product, categoryId?: string | null): string {
  const condition = product.ebay_condition ?? product.original_condition ?? ''
  // eBayのコンディションIDはカテゴリ依存。添付テンプレートの
  // Video Games（139973）では中古品が5000として定義される。
  if (
    categoryId === '139973'
    && ['良い', '普通', '中古', '目立った傷や汚れなし', 'やや傷や汚れあり', '傷や汚れあり'].includes(condition)
  ) {
    return '5000'
  }
  return CONDITION_ID_MAP[condition] ?? '3000'
}

// ユーザー要望: Item Specifics列(C:列)は、以前は全カテゴリ共通の固定
// リスト(ゲーム向け)だったため、音楽CD等の別カテゴリで必要な項目
// (Artist, Record Label等)が出力されなかった。呼び出し側(APIルート)が
// eBay Taxonomy APIから取得したカテゴリ別の実際の項目名を渡せるように
// し、渡されない場合は従来の固定リストにフォールバックする。
// なお、eBayのCSVアップロード・specifics-inの取込はC:列を列名で
// マッチングするため、列数がカテゴリごとに変動しても問題ない
// (先頭の基本列群のみ位置依存)。
export function generateListingCsv(
  products: Product[],
  options: ListingExportOptions,
  itemSpecificColumns: readonly string[] = EBAY_UPLOAD_ITEM_SPECIFIC_COLUMNS,
): string {
  const names = itemSpecificColumns
  const headers = [...EBAY_UPLOAD_BASE_HEADERS, ...names.map((name) => `C:${name}`)]
  const rows = products.map((product, index) => {
    const specifics = productSpecifics(product)
    const category = product.ebay_category_id ?? options.categoryId ?? ''
    const brand = product.ebay_brand?.trim() || specifics.Brand?.join('|') || 'NO BRAND'
    const country = specifics.Country?.join('|') || 'Japan'
    const upc = specifics.UPC?.join('|') || 'NA'
    const price = Number(product.ebay_price)
    const row = [
      'Add',
      productCustomLabel(product),
      Number.isFinite(price) && price > 0 ? price.toFixed(2) : '',
      conditionIdForProduct(product, category),
      (product.ebay_title ?? product.original_title).slice(0, 80),
      listingCsvDescription(product),
      brand,
      productImages(product).slice(0, 24).join('|'),
      upc,
      category,
      '1',
      'payAddress',
      options.paymentProfileName,
      options.returnProfileName,
      options.shippingProfileName,
      'JP',
      'Japan',
      '0.0',
      '0.0',
      '0.0',
      'GTC',
      product.price_type === 'auction' ? 'Auction' : 'FixedPriceItem',
      '1',
      'USD',
      'US',
      country,
      ...names.map((name) => (specifics[name] ?? []).join('|') || 'NA'),
    ]
    if (row.length !== headers.length) {
      throw new Error(
        `eBay出品CSVの${index + 2}行目が${row.length}列です（必要: ${headers.length}列）`,
      )
    }
    return row.map((value) => escapeCsv(String(value))).join(',')
  })

  return `\uFEFF${[headers.join(','), ...rows].join('\r\n')}`
}

// ユーザー要望: specifics-in(外部ツール)がこのjp_spec列の内容から
// カテゴリ別のItem Specificsを自動生成しているため、公式ツールと同様に
// 仕入元サイトの生データ(カテゴリ階層・出品者情報・商品状態など)を
// 優先して出力する。取得できていない商品(古い抽出・生データ非対応
// サイトなど)は従来通りの簡易スナップショットにフォールバックする。
function sourceSnapshot(product: Product): string {
  if (product.raw_source_data) {
    return JSON.stringify(product.raw_source_data)
  }
  return JSON.stringify({
    id: product.source_item_id,
    url: product.source_url,
    site: product.source_site,
    title: product.original_title,
    description: product.original_description,
    price: product.original_price,
    images: product.original_images,
    condition: product.original_condition,
  })
}

export function productImages(product: Product): string[] {
  const images = product.ebay_images?.length
    ? product.ebay_images
    : (product.original_images ?? [])
  const unique = [...new Set(images.filter((url) => url.trim()))]
  const mercariOriginals = unique.filter((url) => url.includes('/item/detail/orig/'))
  return mercariOriginals.length > 0 ? mercariOriginals : unique
}

const SPECIFICS_IN_HEADERS = [
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
  'jp_desc',
  'jp_title',
  'jp_spec',
]

export const SPECIFICS_IN_COLUMN_COUNT = 45

// 呼び出し側(APIルート)がレスポンスヘッダー等で実際の出力列数を知る
// ためのヘルパー(itemSpecificColumnsがカテゴリごとに変動するため)。
export function specificsInColumnCount(itemSpecificColumns: readonly string[]): number {
  return SPECIFICS_IN_HEADERS.length + itemSpecificColumns.length
}

// itemSpecificColumnsが渡された場合(eBay Taxonomy APIから取得したカテゴリ
// 別の実際の項目名)はそちらを使い、渡されない場合は従来の固定リストに
// フォールバックする。Specifics-INの取込はC:列を列名でマッチングするため
// 列数がカテゴリごとに変動しても問題ない(先頭の基本列群のみ位置依存)。
export function generateSpecificsCsv(
  products: Product[],
  options: ListingExportOptions,
  itemSpecificColumns: readonly string[] = EBAY_UPLOAD_ITEM_SPECIFIC_COLUMNS,
): string {
  const names = itemSpecificColumns
  const headers = [...SPECIFICS_IN_HEADERS, ...names.map((name) => `C:${name}`)]

  const rows = products.map((product, index) => {
    const specifics = productSpecifics(product)
    const condition = product.ebay_condition ?? product.original_condition ?? ''
    const brand = product.ebay_brand?.trim() || specifics.Brand?.join('|') || 'NA'
    const country = specifics.Country?.join('|') || 'Japan'
    const upc = specifics.UPC?.join('|') || 'NA'
    const price = Number(product.ebay_price)
    const row = [
      'Add',
      productCustomLabel(product),
      Number.isFinite(price) && price > 0 ? price.toFixed(2) : '',
      CONDITION_ID_MAP[condition] ?? '3000',
      (product.ebay_title ?? product.original_title).slice(0, 80),
      listingDescription(product),
      brand,
      productImages(product).slice(0, 24).join('|'),
      upc,
      product.ebay_category_id ?? options.categoryId ?? '',
      '1',
      'payAddress',
      options.paymentProfileName,
      options.returnProfileName,
      options.shippingProfileName,
      'JP',
      'Japan',
      '0.0',
      '0.0',
      '0.0',
      'GTC',
      product.price_type === 'auction' ? 'Auction' : 'FixedPriceItem',
      '1',
      'USD',
      'US',
      country,
      product.original_description ?? '',
      product.original_title,
      sourceSnapshot(product),
      ...names.map((name) => (specifics[name] ?? []).join('|') || 'NA'),
    ]
    if (row.length !== headers.length) {
      throw new Error(
        `Specifics-INの${index + 2}行目が${row.length}列です（必要: ${headers.length}列）`,
      )
    }
    return row.map((value) => escapeCsv(String(value))).join(',')
  })
  return `\uFEFF${[headers.join(','), ...rows].join('\r\n')}`
}
