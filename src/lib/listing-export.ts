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

const LISTING_HEADERS = [
  'Action(CC=Cp1252)',
  'CustomLabel',
  'StartPrice',
  'ConditionID',
  'Title',
  'Description',
  'PicURL',
  'Category',
  'PaymentProfileName',
  'ReturnProfileName',
  'ShippingProfileName',
  'Country',
  'Location',
  'Duration',
  'Format',
  'Quantity',
  'Currency',
  'SiteID',
]

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
  return `deepbay_${product.id.replace(/-/g, '_')}`
}

function productSpecifics(product: Product): Record<string, string[]> {
  const specifics = { ...(product.ebay_item_specifics ?? {}) }
  if (product.ebay_brand?.trim() && !specifics.Brand?.length) {
    specifics.Brand = [product.ebay_brand.trim()]
  }
  return specifics
}

function specificNames(products: Product[], excludedNames: string[] = []): string[] {
  const excluded = new Set(excludedNames.map((name) => name.toLowerCase()))
  return [...new Set(products.flatMap((product) => Object.keys(productSpecifics(product))))]
    .filter((name) => !excluded.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'en'))
}

function listingDescription(product: Product): string {
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

export function generateListingCsv(products: Product[], options: ListingExportOptions): string {
  const names = specificNames(products)
  const headers = [...LISTING_HEADERS, ...names.map((name) => `C:${name}`)]
  const rows = products.map((product) => {
    const specifics = productSpecifics(product)
    const condition = product.ebay_condition ?? product.original_condition ?? ''
    const category = product.ebay_category_id ?? options.categoryId ?? ''
    const row = [
      'Add',
      productCustomLabel(product),
      Number(product.ebay_price).toFixed(2),
      CONDITION_ID_MAP[condition] ?? '3000',
      (product.ebay_title ?? product.original_title).slice(0, 80),
      listingDescription(product),
      productImages(product).slice(0, 12).join('|'),
      category,
      options.paymentProfileName,
      options.returnProfileName,
      options.shippingProfileName,
      'JP',
      'Japan',
      'GTC',
      product.price_type === 'auction' ? 'Auction' : 'FixedPriceItem',
      '1',
      'USD',
      'US',
      ...names.map((name) => (specifics[name] ?? []).join('|')),
    ]
    return row.map((value) => escapeCsv(String(value))).join(',')
  })

  return `\uFEFF${[headers.join(','), ...rows].join('\r\n')}`
}

function sourceSnapshot(product: Product): string {
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

function productImages(product: Product): string[] {
  return product.ebay_images?.length
    ? product.ebay_images
    : (product.original_images ?? [])
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

const SPECIFICS_IN_ITEM_SPECIFIC_COLUMNS = [
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
]

export const SPECIFICS_IN_COLUMN_COUNT = 45

export function generateSpecificsCsv(products: Product[], options: ListingExportOptions): string {
  // Specifics-INの取込テンプレートは列位置で判定するため、商品データや
  // カテゴリの有無にかかわらず必ず同じ45列を出力する。
  const names = SPECIFICS_IN_ITEM_SPECIFIC_COLUMNS
  const headers = [...SPECIFICS_IN_HEADERS, ...names.map((name) => `C:${name}`)]
  if (headers.length !== SPECIFICS_IN_COLUMN_COUNT) {
    throw new Error(`Specifics-INヘッダーは${SPECIFICS_IN_COLUMN_COUNT}列である必要があります`)
  }

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
      productImages(product).slice(0, 12).join('|'),
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
    if (row.length !== SPECIFICS_IN_COLUMN_COUNT) {
      throw new Error(
        `Specifics-INの${index + 2}行目が${row.length}列です（必要: ${SPECIFICS_IN_COLUMN_COUNT}列）`,
      )
    }
    return row.map((value) => escapeCsv(String(value))).join(',')
  })
  return `\uFEFF${[headers.join(','), ...rows].join('\r\n')}`
}
