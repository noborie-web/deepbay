import type { ScrapedProduct } from '@/lib/scrapers/types'

const JPY_TO_USD = 0.0067  // 約149円/ドル

const CONDITION_ID_MAP: Record<string, string> = {
  '新品、未使用': '1000',
  '未使用に近い': '1500',
  '目立った傷や汚れなし': '2500',
  'やや傷や汚れあり': '3000',
  '傷や汚れあり': '4000',
  '全体的に状態が悪い': '7000',
}

function toConditionId(condition: string | null): string {
  if (!condition) return '3000'
  return CONDITION_ID_MAP[condition] ?? '3000'
}

function customLabel(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const uuid = crypto.randomUUID().replace(/-/g, '_')
  return `ele_${date}_${uuid}`
}

function buildDescription(product: ScrapedProduct): string {
  const conditionText = product.condition ?? 'Pre-owned / Used'
  const descText = product.description
    ? `<li><p style="margin-bottom: 2em; padding: 0.5em 2em;">${product.description.replace(/\n/g, '<br>').slice(0, 2000)}</p></li>`
    : ''

  const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>.tmpl{word-break:break-word;width:100%;background:#fff;border:1px solid #000;padding:0 20px 30px;box-sizing:border-box}.tmpl h1{font-family:Verdana,sans-serif;font-weight:700;font-size:22px;margin:30px 0;text-align:center;color:#111}.tmpl h2{font-family:Verdana,sans-serif;margin:0 0 15px;font-size:18px;background:#1c1c1c;color:#fff;padding:10px}.tmpl p{word-break:break-word;font-family:Verdana,sans-serif;margin:0;padding:0 10px 20px;color:#111;text-align:left;line-height:24px;font-size:14px}</style><div class="tmpl"><h1><br></h1><section><h2>Description</h2><ol><li><p style="margin-bottom:2em;padding:.5em 2em;color:#333">Condition: <font color="red"><b>${conditionText}</b></font></p></li>${descText}<li><p style="margin-bottom:2em;padding:.5em 2em"><font color="#ff0000"><b>Please feel free to contact us. We will reply within 2 days.</b></font></p></li></ol></section><aside><h2>Shipping</h2><p>Shipping from Monday to Friday. We do not mark merchandise values below value or mark items as gifts.</p><h2>About Importer's Obligation</h2><p>Import duties, taxes, and charges are the buyer's responsibility.</p></aside></div>`

  return `<![CDATA[${html}]]>`
}

export interface EbayCsvOptions {
  category: string
  paymentProfileName: string
  returnProfileName: string
  shippingProfileName: string
  sellerEmail?: string
  exchangeRate?: number
}

const CSV_HEADERS = [
  'Action(CC=Cp1252)', 'CustomLabel', 'StartPrice', 'ConditionID', 'Title', 'Description',
  'C:Brand', 'PicURL', 'UPC', 'Category', 'PayPalAccepted', 'PayPalEmailAddress',
  'PaymentProfileName', 'ReturnProfileName', 'ShippingProfileName',
  'Country', 'Location', 'Apply Profile Domestic', 'Apply Profile International',
  'BuyerRequirements:LinkedPayPalAccount', 'Duration', 'Format', 'Quantity',
  'Currency', 'SiteID', 'C:Country', 'C:Accents', 'C:California Prop 65 Warning',
  'C:Chest Size', 'C:Closure', 'C:Collar Style', 'C:Color', 'C:Country/Region of Manufacture',
  'C:Department', 'C:Fabric Type', 'C:Features', 'C:Fit', 'C:Garment Care',
  'C:Handmade', 'C:Insulation Material', 'C:Jacket/Coat Length', 'C:Lining Material',
  'C:MPN', 'C:Model', 'C:Occasion', 'C:Outer Shell Material', 'C:Pattern',
  'C:Performance/Activity', 'C:Personalization Instructions', 'C:Personalize',
  'C:Product Line', 'C:Season', 'C:Size', 'C:Size Type', 'C:Style', 'C:Theme',
  'C:Type', 'C:Unit Quantity', 'C:Unit Type', 'C:Vintage', 'C:Warmth Weight',
]

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function generateEbayCsv(
  products: ScrapedProduct[],
  options: EbayCsvOptions,
): string {
  const rate = options.exchangeRate ?? JPY_TO_USD

  const rows = products.map((p) => {
    const row = [
      'Add',
      customLabel(),
      p.price ? (p.price * rate).toFixed(2) : '9.99',
      toConditionId(p.condition),
      p.title.slice(0, 80),
      buildDescription(p),
      p.category ?? 'NA',
      p.images.slice(0, 12).join('|'),
      'NA',
      options.category,
      '1',
      options.sellerEmail ?? 'payAddress',
      options.paymentProfileName,
      options.returnProfileName,
      options.shippingProfileName,
      'JP',
      'Japan',
      '0.0',
      '0.0',
      '0.0',
      'GTC',
      'FixedPriceItem',
      '1',
      'USD',
      'US',
      'Japan',
      ...Array(34).fill('NA'),
    ]
    return row.map(escapeCsv).join(',')
  })

  return [CSV_HEADERS.join(','), ...rows].join('\r\n')
}

export function applyBulkSettings(
  product: ScrapedProduct,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setting: any,
): { title: string; price: number | null } {
  const title = `${setting.title_prefix ?? ''}${product.title}${setting.title_suffix ?? ''}`.slice(0, 80)
  const price = product.price && setting.price_rate
    ? Math.ceil(product.price * setting.price_rate)
    : product.price
  return { title, price }
}
