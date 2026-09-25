// eBay Trading API mutation helpers — EndItem, ReviseInventoryStatus, ReviseItem, AddFixedPriceItem (stack)
import { refreshEbayToken } from './ebay-inventory'
import { currencyForSite, tradingSiteIdFor } from './ebay-sites'

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'
const TRADING_API_VERSION = '1455'

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function getTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

// ユーザー要望(2026-09-25): UK/AUにも出品する。Trading APIの操作は出品した
// サイトのSiteIDで呼ばないと、価格の通貨やポリシーが食い違って失敗する。
async function tradingCall(
  accessToken: string,
  callName: string,
  body: string,
  siteId?: string | null,
): Promise<string> {
  const res = await fetch(TRADING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_API_VERSION,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': tradingSiteIdFor(siteId),
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

async function runItemAction(accessToken: string, callName: string, xml: string, itemId: string, siteId?: string | null): Promise<EbayActionResult> {
  try {
    const response = await tradingCall(accessToken, callName, xml, siteId)
    return { itemId, ...parseActionResponse(response) }
  } catch (error) {
    return { itemId, success: false, error: actionError(error) }
  }
}

// EndItem — 完全取り下げ
export async function endItem(accessToken: string, itemId: string, siteId?: string | null): Promise<EbayActionResult> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndItemRequest>`
  return runItemAction(accessToken, 'EndItem', xml, itemId, siteId)
}

// ReviseInventoryStatus — quantity=0 に設定（出品継続のまま在庫0）
export async function reviseQuantityToZero(accessToken: string, itemId: string, siteId?: string | null): Promise<EbayActionResult> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Quantity>0</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
  return runItemAction(accessToken, 'ReviseInventoryStatus', xml, itemId, siteId)
}

// ReviseInventoryStatus — 価格変更
export async function revisePrice(
  accessToken: string,
  itemId: string,
  newPrice: number,
  siteId?: string | null,
): Promise<EbayActionResult> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <StartPrice currencyID="${currencyForSite(siteId)}">${newPrice.toFixed(2)}</StartPrice>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
  return runItemAction(accessToken, 'ReviseInventoryStatus', xml, itemId, siteId)
}

// ReviseInventoryStatus — 複数件を1回の呼び出しでまとめて更新する。
// ユーザー要望: 価格改定が110件のうち62件で時間切れになり48件が翌日に
// 持ち越された。ReviseInventoryStatusは1リクエストに最大4件まで含められる
// ため4件ずつまとめ、さらに数リクエストを並行して送ることで、同じ時間で
// 10倍以上の件数を処理する。まとめたリクエストがエラーになった場合は、
// どの商品が失敗したかを特定するため1件ずつ送り直す。
export interface InventoryStatusEntry {
  itemId: string
  price?: number
  quantity?: number
  // 出品したサイト(US/UK/AU)。1リクエストに混ぜられないためサイト単位で送る。
  siteId?: string | null
}

const REVISE_INVENTORY_STATUS_MAX_PER_REQUEST = 4
const DEFAULT_REVISE_CONCURRENCY = 3

function inventoryStatusXml(entries: InventoryStatusEntry[]): string {
  const blocks = entries.map(e => `  <InventoryStatus>
    <ItemID>${escapeXml(e.itemId)}</ItemID>${e.price !== undefined ? `
    <StartPrice currencyID="${currencyForSite(e.siteId)}">${e.price.toFixed(2)}</StartPrice>` : ''}${e.quantity !== undefined ? `
    <Quantity>${Math.max(0, Math.floor(e.quantity))}</Quantity>` : ''}
  </InventoryStatus>`).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
${blocks}
</ReviseInventoryStatusRequest>`
}

async function reviseInventoryStatusChunk(accessToken: string, entries: InventoryStatusEntry[]): Promise<EbayActionResult[]> {
  const siteId = entries[0]?.siteId ?? null
  if (entries.length === 1) {
    return [await runItemAction(accessToken, 'ReviseInventoryStatus', inventoryStatusXml(entries), entries[0].itemId, siteId)]
  }
  try {
    const response = await tradingCall(accessToken, 'ReviseInventoryStatus', inventoryStatusXml(entries), siteId)
    const parsed = parseActionResponse(response)
    if (parsed.success) return entries.map(e => ({ itemId: e.itemId, success: true }))
  } catch {
    // まとめて送れなかった場合も1件ずつ送り直して結果を確定させる
  }
  const results: EbayActionResult[] = []
  for (const entry of entries) {
    results.push(await runItemAction(accessToken, 'ReviseInventoryStatus', inventoryStatusXml([entry]), entry.itemId, entry.siteId ?? null))
  }
  return results
}

export interface ReviseInventoryStatusOptions {
  concurrency?: number
  // この時刻(Date.now()基準のms)を過ぎたら残りは送らず deferred に数える
  deadlineMs?: number
}

export interface ReviseInventoryStatusBatchResult {
  results: EbayActionResult[]
  deferred: number
}

export async function reviseInventoryStatusBatch(
  accessToken: string,
  entries: InventoryStatusEntry[],
  options: ReviseInventoryStatusOptions = {},
): Promise<ReviseInventoryStatusBatchResult> {
  // サイトが違う出品を1リクエストに混ぜると通貨が食い違うため、サイトごとに
  // まとめてから4件ずつに分割する。
  const bySite = new Map<string, InventoryStatusEntry[]>()
  for (const entry of entries) {
    const key = (entry.siteId ?? 'US').toUpperCase()
    const list = bySite.get(key) ?? []
    list.push(entry)
    bySite.set(key, list)
  }
  const chunks: InventoryStatusEntry[][] = []
  for (const siteEntries of bySite.values()) {
    for (let i = 0; i < siteEntries.length; i += REVISE_INVENTORY_STATUS_MAX_PER_REQUEST) {
      chunks.push(siteEntries.slice(i, i + REVISE_INVENTORY_STATUS_MAX_PER_REQUEST))
    }
  }
  const results: EbayActionResult[] = []
  let deferred = 0
  let next = 0
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_REVISE_CONCURRENCY))
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]
      if (options.deadlineMs !== undefined && Date.now() > options.deadlineMs) { deferred += chunk.length; continue }
      results.push(...await reviseInventoryStatusChunk(accessToken, chunk))
    }
  }))
  return { results, deferred }
}

// ReviseItem — 説明文(HTML)の差し替え。ユーザー要望: 出品済み商品の日本語
// 説明文を英訳してeBayに反映する。
export async function reviseDescription(accessToken: string, itemId: string, descriptionHtml: string, siteId?: string | null): Promise<EbayActionResult> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Description><![CDATA[${descriptionHtml.replace(/]]>/g, ']]&gt;')}]]></Description>
  </Item>
</ReviseItemRequest>`
  return runItemAction(accessToken, 'ReviseItem', xml, itemId, siteId)
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
