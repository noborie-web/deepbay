import type { Product } from '@/types/database'
import type { BulkEditSetting } from '@/types/database'

// 日本語の商品状態 → eBay Condition ID マッピング
const CONDITION_MAP: Record<string, { id: string; label: string }> = {
  '新品、未使用': { id: '1000', label: 'New' },
  '未使用に近い': { id: '1500', label: 'Open box' },
  '目立った傷や汚れなし': { id: '3000', label: 'Used' },
  'やや傷や汚れあり': { id: '3000', label: 'Used' },
  '傷や汚れあり': { id: '5000', label: 'For parts or not working' },
  '全体的に状態が悪い': { id: '7000', label: 'For parts or not working' },
  // ヤフオク
  '未使用': { id: '1000', label: 'New' },
  '良い': { id: '3000', label: 'Used' },
  '可': { id: '5000', label: 'For parts or not working' },
  '悪い': { id: '7000', label: 'For parts or not working' },
}

// eBay Flat File (カテゴリ別出品) のカラム定義
const EBAY_CSV_COLUMNS = [
  'Action(SiteID=Japan|Country=JP|Currency=JPY|Version=1193|CC=UTF-8)',
  'Category',
  'Title',
  'ConditionID',
  'Description',
  'Format',
  'Duration',
  'StartPrice',
  'BuyItNowPrice',
  'Quantity',
  'PicURL',
  'ShippingType',
  'ShippingService',
  'ShippingServiceCost',
  'DispatchTimeMax',
  'Location',
  'Country',
  'PaymentProfileName',
  'ReturnProfileName',
  'ShippingProfileName',
]

export interface EbayRow {
  action: string
  categoryId: string
  title: string
  conditionId: string
  description: string
  startPrice: number
  buyItNowPrice?: number
  images: string[]
  quantity: number
  location: string
}

function applyBulkSettings(product: Product, settings?: BulkEditSetting | null): EbayRow {
  const rate = settings?.price_rate ?? 1.0
  const prefix = settings?.title_prefix ?? ''
  const suffix = settings?.title_suffix ?? ''
  const condMap: Record<string, string> = settings?.condition_mapping ?? {}

  const rawTitle = product.ebay_title ?? product.original_title ?? ''
  const title = `${prefix}${rawTitle}${suffix}`.slice(0, 80) // eBay title max 80 chars

  const originalCondKey = product.original_condition ?? ''
  const mappedCond = condMap[originalCondKey] ?? originalCondKey
  const conditionEntry = CONDITION_MAP[mappedCond] ?? CONDITION_MAP[originalCondKey] ?? { id: '3000', label: 'Used' }

  const basePrice = product.ebay_price ?? product.original_price ?? 0
  const startPrice = Math.ceil(basePrice * rate)

  const images = (product.ebay_images?.length ? product.ebay_images : product.original_images) as string[]

  return {
    action: 'Add',
    categoryId: product.ebay_category_id ?? '',
    title,
    conditionId: conditionEntry.id,
    description: buildHtmlDescription(
      product.ebay_description ?? product.original_description ?? '',
      settings?.description_template,
    ),
    startPrice,
    images,
    quantity: 1,
    location: 'Japan',
  }
}

function buildHtmlDescription(description: string, template?: string): string {
  const escaped = description
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')

  if (template) {
    return template.replace('{{description}}', escaped)
  }

  return `<div style="font-family:sans-serif;line-height:1.6">${escaped}</div>`
}

function rowToCsvLine(row: EbayRow): string {
  const picUrls = row.images.slice(0, 12).join('|') // eBay最大12枚

  const values = [
    row.action,
    row.categoryId,
    row.title,
    row.conditionId,
    row.description,
    'FixedPriceItem',
    'GTC',
    row.startPrice.toString(),
    (row.buyItNowPrice ?? row.startPrice).toString(),
    row.quantity.toString(),
    picUrls,
    'Flat',
    'JP_EMS',
    '0',
    '3',
    row.location,
    'JP',
    '',
    '',
    '',
  ]

  return values.map(escapeCsv).join(',')
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function generateEbayCsv(
  products: Product[],
  bulkSetting?: BulkEditSetting | null,
): string {
  const header = EBAY_CSV_COLUMNS.join(',')
  const rows = products.map((p) => {
    const row = applyBulkSettings(p, bulkSetting)
    return rowToCsvLine(row)
  })
  return [header, ...rows].join('\n')
}
