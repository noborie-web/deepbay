import type { Product } from '@/types/database'

export interface ListingPolicies {
  paymentProfileName: string
  returnProfileName: string
  shippingProfileName: string
}

export interface ListingExportOptions extends ListingPolicies {
  categoryId: string | null
  sellerId: string
  // 出品カテゴリー管理画面で設定した、商品状態→ConditionIDの対応。
  // 未設定(null/undefined)なら従来の標準マッピングを使う。
  conditionMap?: Record<string, string> | null
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

// カテゴリー別ConditionID設定UIが対応すべき商品状態の一覧。
// 前半6つは商品編集画面で選択できるeBay側の状態(pricing.tsのallow-list)、
// 後半6つはメルカリ等のスクレイパーがoriginal_conditionに入れる状態。
export const CONDITION_GRADES = [
  '新品', '新品同様', '良い', '普通', '中古', 'ジャンク',
  '新品、未使用', '未使用に近い', '目立った傷や汚れなし',
  'やや傷や汚れあり', '傷や汚れあり', '全体的に状態が悪い',
] as const

// eBayのConditionID一覧(公式のCondition ID値)。カテゴリによって使える
// 値が異なるため、どれを使うかはカテゴリーごとに設定できるようにする。
export const EBAY_CONDITION_OPTIONS: { id: string; label: string }[] = [
  { id: '1000', label: '1000 / New(新品)' },
  { id: '1500', label: '1500 / New other(新品・その他)' },
  { id: '1750', label: '1750 / New with defects(新品・難あり)' },
  { id: '2000', label: '2000 / Manufacturer refurbished' },
  { id: '2500', label: '2500 / Seller refurbished' },
  { id: '2750', label: '2750 / Like New(未使用に近い)' },
  { id: '3000', label: '3000 / Used(中古)' },
  { id: '4000', label: '4000 / Very Good(良い)' },
  { id: '5000', label: '5000 / Good(普通)' },
  { id: '6000', label: '6000 / Acceptable(可)' },
  { id: '7000', label: '7000 / For parts or not working(ジャンク)' },
]

// 実データで確認済み: eBayのCD(176984)等メディア系カテゴリは3000(Used)を
// 受け付けず、アップロードが "The provided condition id is invalid for the
// selected primary category id." で失敗する。メディア系はNew / Like New /
// Very Good / Good / Acceptable の階層を使う。設定UIのプリセットとして使う。
export const MEDIA_CONDITION_MAP: Record<string, string> = {
  '新品': '2750',
  '新品同様': '2750',
  '良い': '4000',
  '普通': '5000',
  '中古': '5000',
  'ジャンク': '6000',
  '新品、未使用': '2750',
  '未使用に近い': '2750',
  '目立った傷や汚れなし': '4000',
  'やや傷や汚れあり': '5000',
  '傷や汚れあり': '6000',
  '全体的に状態が悪い': '6000',
}

export const STANDARD_CONDITION_MAP: Record<string, string> = { ...CONDITION_ID_MAP }

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

// eBayのConditionIDはカテゴリ依存で、カテゴリによっては特定のIDを
// 受け付けない(実データ確認: CD=176984 は3000を拒否)。そのため
// 出品カテゴリー管理画面でカテゴリごとに設定したマッピング
// (listing_categories.condition_map)があればそれを最優先で使う。
export function conditionIdForProduct(
  product: Product,
  categoryId?: string | null,
  conditionMap?: Record<string, string> | null,
): string {
  const condition = product.ebay_condition ?? product.original_condition ?? ''

  const configured = conditionMap?.[condition]
  if (configured) return configured

  // カテゴリー別設定が無い場合の従来動作。添付テンプレートの
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
      conditionIdForProduct(product, category, options.conditionMap),
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
    const category = product.ebay_category_id ?? options.categoryId ?? ''
    const brand = product.ebay_brand?.trim() || specifics.Brand?.join('|') || 'NA'
    const country = specifics.Country?.join('|') || 'Japan'
    const upc = specifics.UPC?.join('|') || 'NA'
    const price = Number(product.ebay_price)
    const row = [
      'Add',
      productCustomLabel(product),
      Number.isFinite(price) && price > 0 ? price.toFixed(2) : '',
      conditionIdForProduct(product, category, options.conditionMap),
      (product.ebay_title ?? product.original_title).slice(0, 80),
      listingDescription(product),
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
