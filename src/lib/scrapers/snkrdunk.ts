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
function itemToProduct(item: any): ScrapedProduct | null {
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

  const largeImages = images.map((url: string) =>
    url.includes('?') ? url.replace(/\?.*$/, '?size=l') : `${url}?size=l`
  )

  const price = item.price ?? item.minPrice ?? item.lowestPrice ?? null

  return {
    sourceUrl: `https://snkrdunk.com/apparel/used/${itemId}`,
    sourceSite: 'snkrdunk',
    sourceItemId: String(itemId),
    title: item.name ?? item.title ?? item.productName ?? '',
    price: typeof price === 'number' ? price : null,
    description: item.description ?? '',
    images: largeImages,
    condition: item.condition ?? item.itemCondition ?? null,
    category: item.categoryName ?? item.brand?.name ?? null,
  }
}

function extractFromRscData(html: string): unknown[] {
  // Collect all RSC push data strings
  const pushMatches = [...html.matchAll(/self\.__next_f\.push\(\[(\d+),(.*?)\]\)/gs)]
  const combined = pushMatches.map(m => m[2]).join('\n')

  const patterns = [
    /"apparelUsedListings"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"listings"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"items"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"products"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"searchResults"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"result"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
  ]

  for (const source of [combined, html]) {
    for (const pattern of patterns) {
      const match = source.match(pattern)
      if (match) {
        try {
          const arr = JSON.parse(match[1])
          if (Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
            return arr
          }
        } catch {
          // continue
        }
      }
    }
  }

  return []
}

export class SnkrDunkScraper {
  name = 'スニーカーダンク'
  siteKey = 'snkrdunk'
  urlPattern = /snkrdunk\.com/

  matches(url: string): boolean {
    return this.urlPattern.test(url)
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    const { timeoutMs = 20000 } = options

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new ScraperError(`HTTP ${res.status}`, this.siteKey, url)
      }

      const html = await res.text()
      const $ = cheerio.load(html)

      // Try __NEXT_DATA__ first (older Next.js pages)
      const nextDataText = $('#__NEXT_DATA__').text()
      if (nextDataText) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nextData: any = JSON.parse(nextDataText)
        const pageProps = nextData?.props?.pageProps ?? {}
        const candidates = [
          pageProps.listings,
          pageProps.items,
          pageProps.products,
          pageProps.searchResults,
          pageProps.apparelUsedListings,
          pageProps.data?.listings,
          pageProps.data?.items,
          pageProps.initialData?.listings,
          pageProps.initialData?.items,
        ]
        for (const candidate of candidates) {
          if (Array.isArray(candidate) && candidate.length > 0) {
            const products = candidate
              .map((item) => itemToProduct(item))
              .filter((p): p is ScrapedProduct => p !== null && p.title !== '')
            if (products.length > 0) return products
          }
        }
      }

      // Try RSC flight data (Next.js App Router)
      const items = extractFromRscData(html)

      if (items.length === 0) {
        const hasNextF = html.includes('self.__next_f')
        throw new ScraperError(
          `No items found. hasNextData=${!!nextDataText}, hasNextF=${hasNextF}, htmlLength=${html.length}`,
          this.siteKey,
          url
        )
      }

      const products = items
        .map((item) => itemToProduct(item))
        .filter((p): p is ScrapedProduct => p !== null && p.title !== '')

      return products
    } catch (err) {
      if (err instanceof ScraperError) throw err
      throw new ScraperError(
        err instanceof Error ? err.message : 'Unknown error',
        this.siteKey,
        url,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
