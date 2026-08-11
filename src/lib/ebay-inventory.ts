// Read-only eBay inventory sync via Trading API GetMyeBaySelling.
// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import type { InventoryListingInput } from './inventory'

const EBAY_TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'
const PAGE_SIZE = 200
const MAX_PAGES = 25
const DEFAULT_PAGE_TIMEOUT_MS = 10_000
const DEFAULT_TOTAL_TIMEOUT_MS = 45_000

export interface EbayTokenSet {
  accessToken: string
}

export interface EbayInventoryFetchOptions {
  pageTimeoutMs?: number
  totalTimeoutMs?: number
}

/**
 * Refresh an eBay OAuth token using the refresh token.
 */
export async function refreshEbayToken(refreshToken: string): Promise<{
  accessToken: string
  expiresAt: Date
}> {
  const clientId = process.env.EBAY_CLIENT_ID
  const clientSecret = process.env.EBAY_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('eBay OAuth credentials not configured')

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`eBay token refresh failed: ${res.status} ${text}`)
  }

  const json = await res.json() as { access_token: string; expires_in: number }
  const expiresAt = new Date(Date.now() + json.expires_in * 1000 - 60_000)

  return { accessToken: json.access_token, expiresAt }
}

/**
 * Parse GetMyeBaySelling XML response into InventoryListingInput[].
 */
export function parseGetMyeBaySellingResponse(xml: string): {
  items: InventoryListingInput[]
  hasMore: boolean
} {
  const getTag = (src: string, tag: string): string => {
    const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
    return m ? m[1].trim() : ''
  }

  const ack = getTag(xml, 'Ack')
  if (ack === 'Failure') {
    const errMsg = getTag(xml, 'LongMessage') || getTag(xml, 'ShortMessage')
    throw new Error(`eBay API error: ${errMsg}`)
  }

  const itemBlocks = xml.match(/<Item>[\s\S]*?<\/Item>/gi) ?? []
  const items: InventoryListingInput[] = itemBlocks.map((block) => {
    const itemId = getTag(block, 'ItemID')
    const title = getTag(block, 'Title')
    const sku = getTag(block, 'SKU')
    const priceStr = getTag(block, 'CurrentPrice') || getTag(block, 'BuyItNowPrice')
    const qty = getTag(block, 'Quantity')
    const qtySold = getTag(block, 'QuantitySold')
    const status = getTag(block, 'ListingStatus')
    const startTime = getTag(block, 'StartTime')
    const endTime = getTag(block, 'EndTime')

    const parseNum = (s: string): number | null => {
      const n = parseFloat(s)
      return isFinite(n) ? n : null
    }

    return {
      ebayItemId: itemId,
      customLabel: sku || null,
      title,
      currentPrice: parseNum(priceStr),
      quantity: parseNum(qty) != null ? Math.round(parseNum(qty)!) : null,
      quantitySold: parseNum(qtySold) != null ? Math.round(parseNum(qtySold)!) : null,
      listingStatus: status || null,
      startTime: startTime || null,
      endTime: endTime || null,
    }
  })

  const totalPages = parseInt(getTag(xml, 'TotalNumberOfPages') || '1', 10)
  const currentPage = parseInt(getTag(xml, 'PageNumber') || '1', 10)
  const hasMore = currentPage < totalPages

  return { items, hasMore }
}

async function fetchPage(accessToken: string, page: number, timeoutMs: number): Promise<{
  items: InventoryListingInput[]
  hasMore: boolean
}> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${PAGE_SIZE}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(EBAY_TRADING_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-IAF-TOKEN': accessToken,
        'X-EBAY-API-SITEID': '0',
      },
      body: xml,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`eBay API timeout: page ${page} exceeded ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    throw new Error(`eBay API HTTP error: ${res.status}`)
  }

  const text = await res.text()
  return parseGetMyeBaySellingResponse(text)
}

/**
 * Fetch all active eBay listings (read-only, up to MAX_PAGES pages).
 */
export async function fetchAllActiveListings(
  tokens: EbayTokenSet,
  options: EbayInventoryFetchOptions = {},
): Promise<InventoryListingInput[]> {
  const all: InventoryListingInput[] = []
  const pageTimeoutMs = options.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const startedAt = Date.now()

  for (let page = 1; page <= MAX_PAGES; page++) {
    const remainingMs = totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw new Error(`eBay inventory sync timeout: exceeded ${totalTimeoutMs}ms`)
    }

    const { items, hasMore } = await fetchPage(
      tokens.accessToken,
      page,
      Math.min(pageTimeoutMs, remainingMs),
    )
    all.push(...items)
    if (!hasMore) break
  }

  return all
}
