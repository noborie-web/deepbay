// eBay Trading API mutation helpers — EndItem, ReviseInventoryStatus, ReviseItem, AddFixedPriceItem (stack)
import { refreshEbayToken } from './ebay-inventory'

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'
const TRADING_API_VERSION = '1455'

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function getTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

async function tradingCall(accessToken: string, callName: string, body: string): Promise<string> {
  const res = await fetch(TRADING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_API_VERSION,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    body,
  })
  const responseBody = await res.text()
  if (!res.ok) {
    const apiMessage = getTag(responseBody, 'LongMessage') || getTag(responseBody, 'ShortMessage')
    throw new Error(`eBay API HTTP error: ${res.status}${apiMessage ? `: ${apiMessage}` : ''}`)
  }
  if (!responseBody.trim()) throw new Error('eBay API returned an empty response')
  return responseBody
}

export interface EbayActionResult {
  itemId: string
  success: boolean
  error?: string
}

function parseActionResponse(xml: string): { success: boolean; error?: string } {
  const ack = getTag(xml, 'Ack')
  if (ack === 'Success' || ack === 'Warning') return { success: true }

  const apiMessage = getTag(xml, 'LongMessage') || getTag(xml, 'ShortMessage')
  if (apiMessage) return { success: false, error: apiMessage }
  if (ack) return { success: false, error: `eBay API returned unexpected Ack: ${ack}` }
  return { success: false, error: 'eBay API response did not include Ack' }
}

function actionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runItemAction(accessToken: string, callName: string, xml: string, itemId: string): Promise<EbayActionResult> {
  try {
    const response = await tradingCall(accessToken, callName, xml)
    return { itemId, ...parseActionResponse(response) }
  } catch (error) {
    return { itemId, success: false, error: actionError(error) }
  }
}

// EndItem — 完全取り下げ
export async function endItem(accessToken: string, itemId: string): Promise<EbayActionResult> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndItemRequest>`
  return runItemAction(accessToken, 'EndItem', xml, itemId)
}

// ReviseInventoryStatus — quantity=0 に設定（出品継続のまま在庫0）
export async function reviseQuantityToZero(accessToken: string, itemId: string): Promise<EbayActionResult> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Quantity>0</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
  return runItemAction(accessToken, 'ReviseInventoryStatus', xml, itemId)
}

// ReviseInventoryStatus — 価格変更
export async function revisePrice(accessToken: string, itemId: string, newPrice: number): Promise<EbayActionResult> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <StartPrice currencyID="USD">${newPrice.toFixed(2)}</StartPrice>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
  return runItemAction(accessToken, 'ReviseInventoryStatus', xml, itemId)
}

export interface StackItemInput {
  title: string
  price: number
  categoryId: string
  description: string
  pictureUrls: string[]
  sku: string
  paymentProfileName: string
  returnProfileName: string
  shippingProfileName: string
}

// AddFixedPriceItem — 積み上げ（新規出品）
export async function addFixedPriceItem(accessToken: string, item: StackItemInput): Promise<{ success: boolean; itemId?: string; error?: string }> {
  const pictures = item.pictureUrls.slice(0, 12).map(u => `<PictureURL>${escapeXml(u)}</PictureURL>`).join('')
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <AutoPay>false</AutoPay>
    <Country>JP</Country>
    <Currency>USD</Currency>
    <Description>${escapeXml(item.description)}</Description>
    <ConditionID>3000</ConditionID>
    <PrimaryCategory><CategoryID>${escapeXml(item.categoryId)}</CategoryID></PrimaryCategory>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Location>Japan</Location>
    <PictureDetails>${pictures}</PictureDetails>
    <Quantity>1</Quantity>
    <SKU>${escapeXml(item.sku)}</SKU>
    <InventoryTrackingMethod>SKU</InventoryTrackingMethod>
    <StartPrice currencyID="USD">${item.price.toFixed(2)}</StartPrice>
    <Title>${escapeXml(item.title.slice(0, 80))}</Title>
    <SellerProfiles>
      <SellerPaymentProfile><PaymentProfileName>${escapeXml(item.paymentProfileName)}</PaymentProfileName></SellerPaymentProfile>
      <SellerReturnProfile><ReturnProfileName>${escapeXml(item.returnProfileName)}</ReturnProfileName></SellerReturnProfile>
      <SellerShippingProfile><ShippingProfileName>${escapeXml(item.shippingProfileName)}</ShippingProfileName></SellerShippingProfile>
    </SellerProfiles>
  </Item>
</AddFixedPriceItemRequest>`
  try {
    const response = await tradingCall(accessToken, 'AddFixedPriceItem', xml)
    const result = parseActionResponse(response)
    if (!result.success) return result

    const itemId = getTag(response, 'ItemID')
    if (!itemId) return { success: false, error: 'eBay API response did not include ItemID' }
    return { success: true, itemId }
  } catch (error) {
    return { success: false, error: actionError(error) }
  }
}

// トークン取得ヘルパー（refreshTokenがあればrefresh、なければaccessTokenをそのまま使用）
export async function resolveAccessToken(settings: {
  ebay_token: string
  ebay_refresh_token?: string | null
  ebay_token_expires_at?: string | null
}, onRefresh?: (token: { accessToken: string; expiresAt: Date }) => Promise<void>): Promise<string> {
  if (settings.ebay_refresh_token && settings.ebay_token_expires_at) {
    const expiresAt = new Date(settings.ebay_token_expires_at)
    if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
      const refreshed = await refreshEbayToken(settings.ebay_refresh_token)
      await onRefresh?.(refreshed)
      return refreshed.accessToken
    }
  }
  return settings.ebay_token
}
