import * as cheerio from 'cheerio'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serverSearchItemToProduct(item: any): ScrapedProduct | null {
  if (!item) return null

  // itemId format: "uaf-47646401" → extract numeric part
  // link format: "/apparel-free-used-items/47646401"
  const link: string = item.link ?? ''
  const linkIdMatch = link.match(/\/(\d+)$/)
  const itemId = linkIdMatch?.[1] ?? item.itemId ?? ''
  if (!itemId) return null

  const images: string[] = []
  if (item.imageUrl) images.push(item.imageUrl)
  if (item.imageUrls && Array.isArray(item.imageUrls)) images.push(...item.imageUrls.filter(Boolean))

  const price = item.salePrice ?? item.price ?? item.minPrice ?? null

  const sourceUrl = link.startsWith('http')
    ? link
    : `https://snkrdunk.com${link}`

  return {
    sourceUrl,
    sourceSite: 'snkrdunk',
    sourceItemId: String(itemId),
    title: item.title ?? item.name ?? '',
    price: typeof price === 'number' ? price : null,
    description: item.description ?? '',
    images,
    condition: item.condition ?? null,
    category: item.brandId ?? item.categoryId ?? null,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function legacyItemToProduct(item: any): ScrapedProduct | null {
  if (!item) return null

  const itemId = item.id ?? item.listingId ?? String(item.apparelUsedListingId ?? '')
  if (!itemId) return null

  const images: string[] = []
  if (item.imageUrls && Array.isArray(item.imageUrls)) {
    images.push(...item.imageUrls.filter(Boolean))
  } else if (item.imageUrl) {
    images.push(item.imageUrl)
  } else if (item.thumbnailUrl) {
    images.push(item.thumbnailUrl)
  }

  const price = item.price ?? item.minPrice ?? item.lowestPrice ?? null

  return {
    sourceUrl: `https://snkrdunk.com/apparel/used/${itemId}`,
    sourceSite: 'snkrdunk',
    sourceItemId: String(itemId),
    title: item.name ?? item.title ?? item.productName ?? '',
    price: typeof price === 'number' ? price : null,
    description: item.description ?? '',
    images,
    condition: item.condition ?? item.itemCondition ?? null,
    category: item.categoryName ?? item.brand?.name ?? null,
  }
}

function extractFromRscData(html: string): { items: unknown[]; source: 'serverSearchData' | 'legacy' } {
  const pushMatches = [...html.matchAll(/self\.__next_f\.push\(\[(\d+),([\s\S]*?)\]\)/g)]

  // Primary: parse each RSC push string and look for serverSearchData
  for (const match of pushMatches) {
    const dataStr = match[2].trim()
    if (!dataStr.startsWith('"')) continue
    let parsed: string
    try {
      parsed = JSON.parse(dataStr) as string
    } catch { continue }
    if (typeof parsed !== 'string' || !parsed.includes('serverSearchData')) continue

    const sdIdx = parsed.indexOf('"serverSearchData"')
    if (sdIdx === -1) continue
    const afterKey = parsed.slice(sdIdx + '"serverSearchData"'.length).trimStart()
    if (!afterKey.startsWith(':')) continue
    const objStart = afterKey.indexOf('{')
    if (objStart === -1 || objStart > 5) continue
    const jsonStr = afterKey.slice(objStart)
    let depth = 0, end = -1
    for (let i = 0; i < jsonStr.length; i++) {
      if (jsonStr[i] === '{') depth++
      else if (jsonStr[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj: any = JSON.parse(jsonStr.slice(0, end + 1))
      if (obj?.products && Array.isArray(obj.products) && obj.products.length > 0) {
        return { items: obj.products, source: 'serverSearchData' }
      }
    } catch { /* continue */ }
  }

  // Fallback: legacy patterns on raw HTML
  const combined = pushMatches.map(m => m[2]).join('\n')
  const patterns = [
    /"apparelUsedListings"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"listings"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"items"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"products"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"searchResults"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
  ]
  for (const source of [combined, html]) {
    for (const pattern of patterns) {
      const match = source.match(pattern)
      if (match) {
        try {
          const arr = JSON.parse(match[1])
          if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
            return { items: arr, source: 'legacy' }
          }
        } catch { /* continue */ }
      }
    }
  }

  return { items: [], source: 'legacy' }
}

export class SnkrDunkScraper {
  name = 'スニーカーダンク'
  siteKey = 'snkrdunk'
  urlPattern = /snkrdunk\.com/

  matches(url: string): boolean {
    return this.urlPattern.test(url)
  }

  private async scrapePage(url: string, timeoutMs: number): Promise<ScrapedProduct[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { headers: HEADERS, signal: controller.signal })
      if (!res.ok) throw new ScraperError(`HTTP ${res.status}`, this.siteKey, url)
      const html = await res.text()
      const $ = cheerio.load(html)
      const nextDataText = $('#__NEXT_DATA__').text()
      if (nextDataText) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nextData: any = JSON.parse(nextDataText)
        const pageProps = nextData?.props?.pageProps ?? {}
        const candidates = [pageProps.listings, pageProps.items, pageProps.products, pageProps.searchResults, pageProps.apparelUsedListings, pageProps.data?.listings, pageProps.data?.items]
        for (const candidate of candidates) {
          if (Array.isArray(candidate) && candidate.length > 0) {
            const products = candidate.map(legacyItemToProduct).filter((p): p is ScrapedProduct => p !== null && p.title !== '')
            if (products.length > 0) return products
          }
        }
      }
      const { items, source } = extractFromRscData(html)
      const mapper = source === 'serverSearchData' ? serverSearchItemToProduct : legacyItemToProduct
      return items.map(mapper).filter((p): p is ScrapedProduct => p !== null && p.title !== '')
    } finally {
      clearTimeout(timer)
    }
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    const { timeoutMs = 20000, limit = 600, onPage } = options

    // For search URLs, scrape multiple pages
    const isSearchUrl = url.includes('/search') || url.includes('keywords=')
    if (!isSearchUrl) {
      try {
        const products = await this.scrapePage(url, timeoutMs)
        if (products.length === 0) throw new ScraperError('No items found', this.siteKey, url)
        return products
      } catch (err) {
        if (err instanceof ScraperError) throw err
        throw new ScraperError(err instanceof Error ? err.message : 'Unknown error', this.siteKey, url)
      }
    }

    // Multi-page scraping for search URLs
    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()
    const maxPages = Math.ceil(limit / 30)
    const baseUrl = new URL(url)

    for (let page = 1; page <= maxPages && allProducts.length < limit; page++) {
      baseUrl.searchParams.set('page', String(page))
      const pageUrl = baseUrl.toString()
      try {
        const products = await this.scrapePage(pageUrl, timeoutMs)
        if (products.length === 0) break
        for (const p of products) {
          const id = p.sourceItemId ?? p.sourceUrl
          if (!seenIds.has(id)) { seenIds.add(id); allProducts.push(p) }
        }
        onPage?.(allProducts.length, limit)
        if (products.length < 20) break // last page
        if (page < maxPages) await new Promise(r => setTimeout(r, 200))
      } catch {
        if (page === 1) throw new ScraperError('No items found on page 1', this.siteKey, url)
        break
      }
    }

    if (allProducts.length === 0) throw new ScraperError('No items found', this.siteKey, url)
    return allProducts.slice(0, limit)
  }
}
