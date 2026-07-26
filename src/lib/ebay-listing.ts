import type { Product } from '@/types/database'
import type { ListingPolicies } from '@/lib/listing-export'
import {
  conditionIdForProduct,
  listingDescription,
  productCustomLabel,
  productImages,
  productSpecifics,
} from '@/lib/listing-export'

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'
const TRADING_API_VERSION = '1455'

export interface DirectListingOptions extends ListingPolicies {
  categoryId: string | null
}

export interface EbayListingResult {
  itemId: string
  warningMessages: string[]
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlElements(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`
}

function xmlValues(xml: string, tag: string): string[] {
  const matches = xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))
  return [...matches].map((match) => decodeXml(match[1].trim()))
}

export function buildAddFixedPriceItemXml(
  product: Product,
  options: DirectListingOptions,
  messageId: string,
): string {
  const categoryId = product.ebay_category_id ?? options.categoryId ?? ''
  const title = (product.ebay_title ?? product.original_title).slice(0, 80)
  const price = Number(product.ebay_price)
  const specifics = productSpecifics(product)
  const images = productImages(product).slice(0, 24)
  const itemSpecifics = Object.entries(specifics)
    .filter(([name, values]) => name.trim() && values.some((value) => value.trim()))
    .map(([name, values]) => [
      '<NameValueList>',
      xmlElements('Name', name),
      ...values.filter((value) => value.trim()).map((value) => xmlElements('Value', value)),
      '</NameValueList>',
    ].join(''))
    .join('')
  const pictureUrls = images.map((url) => xmlElements('PictureURL', url)).join('')

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
    xmlElements('ErrorLanguage', 'en_US'),
    xmlElements('WarningLevel', 'High'),
    xmlElements('MessageID', messageId),
    '<Item>',
    xmlElements('AutoPay', 'false'),
    xmlElements('Country', 'JP'),
    xmlElements('Currency', 'USD'),
    xmlElements('Description', listingDescription(product)),
    xmlElements('ConditionID', conditionIdForProduct(product, categoryId)),
    `<PrimaryCategory>${xmlElements('CategoryID', categoryId)}</PrimaryCategory>`,
    xmlElements('ListingDuration', 'GTC'),
    xmlElements('ListingType', 'FixedPriceItem'),
    xmlElements('Location', 'Japan'),
    `<PictureDetails>${pictureUrls}</PictureDetails>`,
    xmlElements('Quantity', '1'),
    xmlElements('SKU', productCustomLabel(product)),
    xmlElements('InventoryTrackingMethod', 'SKU'),
    `<StartPrice currencyID="USD">${price.toFixed(2)}</StartPrice>`,
    xmlElements('Title', title),
    '<SellerProfiles>',
    `<SellerPaymentProfile>${xmlElements('PaymentProfileName', options.paymentProfileName)}</SellerPaymentProfile>`,
    `<SellerReturnProfile>${xmlElements('ReturnProfileName', options.returnProfileName)}</SellerReturnProfile>`,
    `<SellerShippingProfile>${xmlElements('ShippingProfileName', options.shippingProfileName)}</SellerShippingProfile>`,
    '</SellerProfiles>',
    itemSpecifics ? `<ItemSpecifics>${itemSpecifics}</ItemSpecifics>` : '',
    '</Item>',
    '</AddFixedPriceItemRequest>',
  ].join('')
}

export function parseAddFixedPriceItemResponse(xml: string): EbayListingResult {
  const ack = xmlValues(xml, 'Ack')[0] ?? ''
  const itemId = xmlValues(xml, 'ItemID')[0] ?? ''
  const errorBlocks = xml.match(/<Errors(?:\s[^>]*)?>[\s\S]*?<\/Errors>/gi) ?? []
  const messages = errorBlocks.map((block) => (
    xmlValues(block, 'LongMessage')[0]
    || xmlValues(block, 'ShortMessage')[0]
    || xmlValues(block, 'ErrorCode')[0]
    || 'eBay出品エラー'
  ))
  if (!['Success', 'Warning'].includes(ack) || !itemId) {
    throw new Error(messages.join(' / ') || `eBay出品に失敗しました（Ack: ${ack || '不明'}）`)
  }
  return {
    itemId,
    warningMessages: ack === 'Warning' ? messages : [],
  }
}

export async function publishFixedPriceItem(
  accessToken: string,
  product: Product,
  options: DirectListingOptions,
): Promise<EbayListingResult> {
  const body = buildAddFixedPriceItemXml(product, options, crypto.randomUUID())
  const response = await fetch(TRADING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'X-EBAY-API-CALL-NAME': 'AddFixedPriceItem',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_API_VERSION,
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    body,
    cache: 'no-store',
  })
  const payload = await response.text()
  if (!response.ok) {
    throw new Error(`eBay Trading API error: ${response.status}`)
  }
  return parseAddFixedPriceItemResponse(payload)
}
