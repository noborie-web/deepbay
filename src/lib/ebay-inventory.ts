// Read-only eBay inventory sync via Trading API GetMyeBaySelling.
// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import type { InventoryListingInput } from './inventory'

const EBAY_TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'
const PAGE_SIZE = 200
// 実データで確認した不具合: 以前は25ページ(5,000件)で打ち切っており、
// アカウント上のactive出品が約5,400件あったため、後ろの約400件(Kakehashi
// で直近に出品した149件を含む)が取得されず、在庫管理に1件も紐付かなかった。
// 上限を50ページ(10,000件)に引き上げるとともに、超過時はtruncatedで
// 呼び出し側へ知らせて警告を表示できるようにする(黙って欠落させない)。
const MAX_PAGES = 50
const DEFAULT_PAGE_TIMEOUT_MS = 10_000
const DEFAULT_TOTAL_TIMEOUT_MS = 45_000
const DEFAULT_CONCURRENCY = 8
const OUTPUT_SELECTORS = [
  'PaginationResult',
  'ItemID',
  'Title',
  'SKU',
  'CurrentPrice',
  'BuyItNowPrice',
  'Quantity',
  'QuantitySold',
  'ListingStatus',
  'PictureDetails',
  'StartTime',
  'EndTime',
] as const

export interface EbayTokenSet {
  accessToken: string
}

export interface EbayInventoryFetchOptions {
  pageTimeoutMs?: number
  totalTimeoutMs?: number
  concurrency?: number
  signal?: AbortSignal
}

export interface EbayInventoryBatchResult {
  items: InventoryListingInput[]
  nextPage: number | null
  totalPages: number
  lastFetchedPage: number
  // eBay側の総ページ数がMAX_PAGESを超えており、一部の出品が取得できていない
  truncated: boolean
  ebayTotalPages: number
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
    const imageUrl = getTag(block, 'GalleryURL') || getTag(block, 'PictureURL')
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
      imageUrl: imageUrl || null,
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
  const outputSelectors = OUTPUT_SELECTORS
    .map((field) => `  <OutputSelector>${field}</OutputSelector>`)
    .join('\n')
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Sort>StartTimeDescending</Sort>
    <Pagination>
      <EntriesPerPage>${PAGE_SIZE}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
${outputSelectors}
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

async function fetchActiveListingRange(
  tokens: EbayTokenSet,
  startPage: number,
  pageCount: number,
  options: EbayInventoryFetchOptions = {},
): Promise<EbayInventoryBatchResult> {
  if (!Number.isInteger(startPage) || startPage < 1 || startPage > MAX_PAGES) {
    throw new Error(`Invalid eBay inventory start page: ${startPage}`)
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`Invalid eBay inventory page count: ${pageCount}`)
  }

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

    const firstPage = await fetchPageWithRetry(startPage)
    all.push(...firstPage.items)

    const totalPages = Math.min(firstPage.totalPages, MAX_PAGES)
    const truncated = firstPage.totalPages > MAX_PAGES
    if (truncated) {
      console.warn(`[ebay-inventory] active listings exceed the fetch cap: eBay reports ${firstPage.totalPages} pages, fetching only ${MAX_PAGES}`)
    }
    const lastPage = Math.min(totalPages, startPage + pageCount - 1)
    if (lastPage <= startPage) {
      return {
        items: all,
        nextPage: null,
        totalPages,
        lastFetchedPage: startPage,
        truncated,
        ebayTotalPages: firstPage.totalPages,
      }
    }

    // The first response confirms the actual total. Fetch the rest of this
    // bounded range concurrently, then restore page order before returning.
    const pageItems: InventoryListingInput[][] = []
    let nextPage = startPage + 1
    const workerCount = Math.min(concurrency, lastPage - startPage)

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextPage <= lastPage) {
        const page = nextPage++
        const result = await fetchPageWithRetry(page)
        pageItems[page] = result.items
      }
    }))

    for (let page = startPage + 1; page <= lastPage; page++) {
      all.push(...(pageItems[page] ?? []))
    }

    return {
      items: all,
      nextPage: lastPage < totalPages ? lastPage + 1 : null,
      totalPages,
      lastFetchedPage: lastPage,
      truncated,
      ebayTotalPages: firstPage.totalPages,
    }
  } catch (error) {
    if (!totalController.signal.aborted) totalController.abort(error)
    throw error
  } finally {
    clearTimeout(totalTimeout)
    options.signal?.removeEventListener('abort', abortForCaller)
  }
}

/**
 * Fetch one bounded batch of active listings for resumable manual sync.
 */
export async function fetchActiveListingsBatch(
  tokens: EbayTokenSet,
  startPage: number,
  pageCount: number,
  options: EbayInventoryFetchOptions = {},
): Promise<EbayInventoryBatchResult> {
  return fetchActiveListingRange(tokens, startPage, pageCount, options)
}

/**
 * Fetch all active eBay listings (read-only, up to MAX_PAGES pages).
 */
export async function fetchAllActiveListings(
  tokens: EbayTokenSet,
  options: EbayInventoryFetchOptions = {},
): Promise<InventoryListingInput[]> {
  const result = await fetchActiveListingRange(tokens, 1, MAX_PAGES, options)
  return result.items
}

// ---------------------------------------------------------------------------
// Kakehashiが出品したItemIDだけを個別照会する方式(GetItem)
//
// ユーザー要望・実データで確認した不具合: eBayアカウント上には他ツールで
// 出品中の商品が約1万件あり、GetMyeBaySellingで全active出品を走査する方式
// では上限・実行時間の制約で最後まで走り切れず、Kakehashiで出品した149件が
// 1件も同期できなかった。Kakehashiが把握しているItemIDだけをGetItemで個別に
// 照会すれば、件数はKakehashiの出品数に比例し(数百件程度)、他ツールの出品数
// に左右されない。
// ---------------------------------------------------------------------------

const DEFAULT_GET_ITEM_CONCURRENCY = 4

// GetItemで「そのItemIDの出品が存在しない/参照できない」ことを示すエラー
// コード。終了済み・削除済みの出品として扱い、同期全体は止めない。
const GET_ITEM_NOT_FOUND_ERROR_CODES = new Set(['17', '37', '21916750', '21917182'])

export interface KnownListingFetchResult {
  // 現在もactiveな出品(最新の在庫数・価格で更新する)
  items: InventoryListingInput[]
  // 終了済み・売却済み・存在しない出品(在庫一覧から除外する)
  endedItemIds: string[]
}

export function parseGetItemResponse(xml: string, itemId: string): InventoryListingInput | 'ended' | 'not_found' {
  const getTag = (src: string, tag: string): string => {
    const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
    return m ? m[1].trim() : ''
  }

  const ack = getTag(xml, 'Ack')
  if (ack === 'Failure') {
    const code = getTag(xml, 'ErrorCode')
    if (GET_ITEM_NOT_FOUND_ERROR_CODES.has(code)) return 'not_found'
    const errMsg = getTag(xml, 'LongMessage') || getTag(xml, 'ShortMessage')
    throw new Error(`eBay GetItem error (${itemId}): ${errMsg || `code ${code}`}`)
  }

  const itemBlock = xml.match(/<Item>[\s\S]*?<\/Item>/i)?.[0] ?? ''
  if (!itemBlock) return 'not_found'

  const sellingStatus = itemBlock.match(/<SellingStatus>[\s\S]*?<\/SellingStatus>/i)?.[0] ?? ''
  const listingDetails = itemBlock.match(/<ListingDetails>[\s\S]*?<\/ListingDetails>/i)?.[0] ?? ''
  const pictureDetails = itemBlock.match(/<PictureDetails>[\s\S]*?<\/PictureDetails>/i)?.[0] ?? ''

  const listingStatus = getTag(sellingStatus, 'ListingStatus')
  if (listingStatus && listingStatus !== 'Active') return 'ended'

  const parseNum = (s: string): number | null => {
    const n = parseFloat(s)
    return isFinite(n) ? n : null
  }
  // GetItemのQuantityは出品時の総数で、残数は QuantitySold を引いて求める
  // (CSV取込の「Available quantity」やActiveListの残数と同じ意味に揃える)。
  const totalQty = parseNum(getTag(itemBlock, 'Quantity'))
  const soldQty = parseNum(getTag(sellingStatus, 'QuantitySold')) ?? 0
  const available = totalQty != null ? Math.max(0, Math.round(totalQty - soldQty)) : null

  return {
    ebayItemId: getTag(itemBlock, 'ItemID') || itemId,
    customLabel: getTag(itemBlock, 'SKU') || null,
    title: getTag(itemBlock, 'Title'),
    imageUrl: getTag(pictureDetails, 'PictureURL') || null,
    currentPrice: parseNum(getTag(sellingStatus, 'CurrentPrice')),
    quantity: available,
    quantitySold: Math.round(soldQty),
    listingStatus: listingStatus || 'Active',
    startTime: getTag(listingDetails, 'StartTime') || null,
    endTime: getTag(listingDetails, 'EndTime') || null,
  }
}

async function fetchItemById(
  accessToken: string,
  itemId: string,
  timeoutMs: number,
  totalSignal?: AbortSignal,
): Promise<InventoryListingInput | 'ended' | 'not_found'> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <OutputSelector>Item.ItemID</OutputSelector>
  <OutputSelector>Item.Title</OutputSelector>
  <OutputSelector>Item.SKU</OutputSelector>
  <OutputSelector>Item.Quantity</OutputSelector>
  <OutputSelector>Item.SellingStatus</OutputSelector>
  <OutputSelector>Item.ListingDetails</OutputSelector>
  <OutputSelector>Item.PictureDetails</OutputSelector>
</GetItemRequest>`

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const abortForTotal = () => controller.abort(totalSignal?.reason)
  totalSignal?.addEventListener('abort', abortForTotal, { once: true })

  try {
    const res = await fetch(EBAY_TRADING_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-IAF-TOKEN': accessToken,
        'X-EBAY-API-SITEID': '0',
      },
      body: xml,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`eBay API HTTP error: ${res.status}`)
    return parseGetItemResponse(await res.text(), itemId)
  } catch (error) {
    if (totalSignal?.aborted) {
      throw totalSignal.reason instanceof Error ? totalSignal.reason : new Error('eBay inventory sync timeout')
    }
    if (timedOut) throw new Error(`eBay API timeout: item ${itemId} exceeded ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timeout)
    totalSignal?.removeEventListener('abort', abortForTotal)
  }
}

/**
 * 指定したItemIDの出品情報をGetItemで個別に取得する。
 * 終了済み・存在しないIDは endedItemIds に振り分け、同期全体は止めない。
 */
export async function fetchListingsByItemIds(
  tokens: EbayTokenSet,
  itemIds: string[],
  options: EbayInventoryFetchOptions = {},
): Promise<KnownListingFetchResult> {
  const uniqueIds = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)))
  const items: InventoryListingInput[] = []
  const endedItemIds: string[] = []
  if (uniqueIds.length === 0) return { items, endedItemIds }

  const itemTimeoutMs = options.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_GET_ITEM_CONCURRENCY))
  const startedAt = Date.now()
  const totalController = new AbortController()
  const abortForCaller = () => totalController.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortForCaller, { once: true })
  const totalTimeout = setTimeout(() => {
    totalController.abort(new Error(`eBay inventory sync timeout: exceeded ${totalTimeoutMs}ms`))
  }, totalTimeoutMs)

  const remainingMs = () => {
    const remaining = totalTimeoutMs - (Date.now() - startedAt)
    if (remaining <= 0) throw new Error(`eBay inventory sync timeout: exceeded ${totalTimeoutMs}ms`)
    return remaining
  }

  const fetchWithRetry = async (itemId: string) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await fetchItemById(tokens.accessToken, itemId, Math.min(itemTimeoutMs, remainingMs()), totalController.signal)
      } catch (error) {
        const isItemTimeout = error instanceof Error && error.message.startsWith(`eBay API timeout: item ${itemId} `)
        if (!isItemTimeout || attempt === 2 || totalController.signal.aborted) throw error
      }
    }
    throw new Error(`eBay API timeout: item ${itemId}`)
  }

  try {
    if (options.signal?.aborted) abortForCaller()
    let next = 0
    // 結果の順序を照会順に揃えるため、indexで受ける
    const results: Array<InventoryListingInput | 'ended' | 'not_found'> = []
    await Promise.all(Array.from({ length: Math.min(concurrency, uniqueIds.length) }, async () => {
      while (next < uniqueIds.length) {
        const index = next++
        results[index] = await fetchWithRetry(uniqueIds[index])
      }
    }))
    uniqueIds.forEach((id, index) => {
      const result = results[index]
      if (result === 'ended' || result === 'not_found') endedItemIds.push(id)
      else if (result) items.push(result)
    })
    return { items, endedItemIds }
  } catch (error) {
    if (!totalController.signal.aborted) totalController.abort(error)
    throw error
  } finally {
    clearTimeout(totalTimeout)
    options.signal?.removeEventListener('abort', abortForCaller)
  }
}
