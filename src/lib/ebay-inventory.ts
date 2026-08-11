// Read-only eBay inventory sync via Trading API GetMyeBaySelling.
// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import type { InventoryListingInput } from './inventory'

const EBAY_TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'
const PAGE_SIZE = 200
const MAX_PAGES = 25
const DEFAULT_PAGE_TIMEOUT_MS = 10_000
const DEFAULT_TOTAL_TIMEOUT_MS = 45_000
const DEFAULT_CONCURRENCY = 4

export interface EbayTokenSet {
  accessToken: string
}

export interface EbayInventoryFetchOptions {
  pageTimeoutMs?: number
  totalTimeoutMs?: number
  concurrency?: number
  signal?: AbortSignal
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
  totalPages: number
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

  return { items, hasMore, totalPages }
}

async function fetchPage(
  accessToken: string,
  page: number,
  timeoutMs: number,
  totalSignal?: AbortSignal,
): Promise<{
  items: InventoryListingInput[]
  hasMore: boolean
  totalPages: number
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
  let pageTimedOut = false
  const timeout = setTimeout(() => {
    pageTimedOut = true
    controller.abort()
  }, timeoutMs)
  const abortForTotalTimeout = () => controller.abort(totalSignal?.reason)
  totalSignal?.addEventListener('abort', abortForTotalTimeout, { once: true })

  try {
    const res = await fetch(EBAY_TRADING_API_URL, {
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

    if (!res.ok) {
      throw new Error(`eBay API HTTP error: ${res.status}`)
    }

    // Keep the timeout active until the response body has been consumed.
    // fetch() can resolve after headers arrive even if the XML body stalls.
    const text = await res.text()
    return parseGetMyeBaySellingResponse(text)
  } catch (error) {
    if (totalSignal?.aborted) {
      throw totalSignal.reason instanceof Error
        ? totalSignal.reason
        : new Error('eBay inventory sync timeout')
    }
    if (pageTimedOut) {
      throw new Error(`eBay API timeout: page ${page} exceeded ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    totalSignal?.removeEventListener('abort', abortForTotalTimeout)
  }
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
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
  const startedAt = Date.now()
  const totalController = new AbortController()
  const abortForCaller = () => totalController.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortForCaller, { once: true })
  const totalTimeout = setTimeout(() => {
    totalController.abort(new Error(`eBay inventory sync timeout: exceeded ${totalTimeoutMs}ms`))
  }, totalTimeoutMs)

  const getRemainingMs = (): number => {
    const remainingMs = totalTimeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw new Error(`eBay inventory sync timeout: exceeded ${totalTimeoutMs}ms`)
    }
    return remainingMs
  }

  const fetchPageWithRetry = async (page: number) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await fetchPage(
          tokens.accessToken,
          page,
          Math.min(pageTimeoutMs, getRemainingMs()),
          totalController.signal,
        )
      } catch (error) {
        const isPageTimeout = error instanceof Error
          && error.message.startsWith(`eBay API timeout: page ${page} `)
        if (!isPageTimeout || attempt === 2 || totalController.signal.aborted) throw error
      }
    }
    throw new Error(`eBay API timeout: page ${page}`)
  }

  try {
    if (options.signal?.aborted) abortForCaller()

    const firstPage = await fetchPageWithRetry(1)
    all.push(...firstPage.items)

    const lastPage = Math.min(firstPage.totalPages, MAX_PAGES)
    if (lastPage <= 1) return all

    // The first response tells us the remaining page numbers. Fetch a small,
    // bounded number concurrently, then restore page order before returning.
    const pageItems: InventoryListingInput[][] = []
    let nextPage = 2
    const workerCount = Math.min(concurrency, lastPage - 1)

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextPage <= lastPage) {
        const page = nextPage++
        const result = await fetchPageWithRetry(page)
        pageItems[page] = result.items
      }
    }))

    for (let page = 2; page <= lastPage; page++) {
      all.push(...(pageItems[page] ?? []))
    }

    return all
  } catch (error) {
    if (!totalController.signal.aborted) totalController.abort(error)
    throw error
  } finally {
    clearTimeout(totalTimeout)
    options.signal?.removeEventListener('abort', abortForCaller)
  }
}
