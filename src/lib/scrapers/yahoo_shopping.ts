import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const SEARCH_URL_PATTERN = /shopping\.yahoo\.co\.jp\/search\//
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// data-beacon属性は "key1:value1;key2:value2;..." 形式の解析用文字列。
function parseBeacon(str: string): Record<string, string> {
  const obj: Record<string, string> = {}
  for (const pair of str.split(';')) {
    const idx = pair.indexOf(':')
    if (idx === -1) continue
    obj[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return obj
}

// 検索URLは /search/{keyword}/{sortCode}(/{page})?/ というパス構造。
// 既存のページ番号セグメントがあれば正規化して除去し、指定ページのURLを組み立てる。
function buildPageUrl(baseUrl: URL, page: number): string {
  const segments = baseUrl.pathname.split('/').filter(Boolean)
  const hasExistingPage = segments.length >= 4 && /^\d+$/.test(segments[3])
  const rootSegments = hasExistingPage ? segments.slice(0, 3) : segments.slice(0, Math.min(segments.length, 3))
  const pathSegments = page > 1 ? [...rootSegments, String(page)] : rootSegments
  const u = new URL(baseUrl.toString())
  u.pathname = `/${pathSegments.join('/')}/`
  return u.toString()
}

export class YahooShoppingScraper extends BaseScraper {
  name = 'ヤフーショッピング'
  siteKey = 'yahoo_shopping'
  urlPattern = /store\.shopping\.yahoo\.co\.jp\/[^/]+\/[a-zA-Z0-9_.-]+\.html/

  matches(url: string): boolean {
    return this.urlPattern.test(url) || SEARCH_URL_PATTERN.test(url)
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    if (SEARCH_URL_PATTERN.test(url)) {
      return this.scrapeSearch(url, options)
    }
    return super.scrape(url, options)
  }

  private async scrapeSearch(url: string, options: ScraperOptions): Promise<ScrapedProduct[]> {
    const { userAgent = DEFAULT_UA, timeoutMs = 15000, limit = 600, onPage } = options
    const baseUrl = new URL(url)

    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()
    let numFound: number | null = null
    const APPROX_PAGE_SIZE = 30
    // 暴走防止用の安全上限
    const maxPages = Math.ceil(limit / APPROX_PAGE_SIZE) + 10

    for (let page = 1; page <= maxPages && allProducts.length < limit; page++) {
      const pageUrl = buildPageUrl(baseUrl, page)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let html: string
      try {
        const res = await fetch(pageUrl, {
          headers: { 'User-Agent': userAgent, 'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3' },
          signal: controller.signal,
        })
        if (!res.ok) {
          if (page === 1) throw new ScraperError(`HTTP ${res.status}: ${res.statusText}`, this.siteKey, url)
          break
        }
        html = await res.text()
      } catch (err) {
        if (page === 1) {
          if (err instanceof ScraperError) throw err
          throw new ScraperError(err instanceof Error ? err.message : 'Unknown error', this.siteKey, url)
        }
        break
      } finally {
        clearTimeout(timer)
      }

      const $ = cheerio.load(html)

      if (numFound === null) {
        const bodyText = $('body').text()
        const m = bodyText.match(/([\d,]+)\s*件/)
        if (m) numFound = parseInt(m[1].replace(/,/g, ''), 10)
      }

      // 1商品につきimg/title/store名など複数のリンク(それぞれdata-beacon付き)が
      // 存在するため、ページ内での重複はここで(.each()の中で)即座に除外する。
      // pageProducts配列を作ってからまとめて除外すると、同一ページ内の重複を
      // 素通りさせてしまう(実データで確認済みの不具合)。
      const pageProducts: ScrapedProduct[] = []
      $('a[href*="store.shopping.yahoo.co.jp"][data-beacon]').each((_, el) => {
        const $el = $(el)
        const beacon = parseBeacon($el.attr('data-beacon') ?? '')
        const itemCode = beacon.itemcode
        const storeId = beacon.storeid
        if (!itemCode || !storeId) return
        const compositeId = `${storeId}_${itemCode}`
        if (seenIds.has(compositeId)) return
        seenIds.add(compositeId)

        const price = beacon.prc ? parseInt(beacon.prc, 10) || null : null
        const imgSrc = $el.find('img').attr('src')
        const reviewCount = beacon.str_rct ? parseInt(beacon.str_rct, 10) || null : null

        pageProducts.push({
          sourceUrl: `https://store.shopping.yahoo.co.jp/${storeId}/${itemCode}.html`,
          sourceSite: this.siteKey,
          sourceItemId: compositeId,
          title: beacon.tname ?? '',
          price,
          description: '',
          images: imgSrc ? [imgSrc] : [],
          condition: null,
          category: null,
          sellerRatingCount: reviewCount,
          shippingDays: null,
          sourceUpdatedAt: null,
        })
      })

      // 「そのページの結果が0件」以外(取得件数がpageSize未満など)を終了条件に
      // してはいけない(メルカリ検索抽出で見つかった不具合と同じ罠)。
      if (pageProducts.length === 0) break

      allProducts.push(...pageProducts)
      onPage?.(allProducts.length, numFound ?? limit)

      if (numFound !== null && allProducts.length >= numFound) break
    }

    if (allProducts.length === 0) {
      throw new ScraperError('検索結果が0件です', this.siteKey, url)
    }

    return allProducts.slice(0, limit)
  }

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    // URLは https://store.shopping.yahoo.co.jp/{ストアID}/{商品コード}.html の形式。
    // 商品コードをsourceItemIdとして使う（ストア内で一意）。
    const itemId = url.match(/store\.shopping\.yahoo\.co\.jp\/[^/]+\/([a-zA-Z0-9_.-]+)\.html/)?.[1] ?? null

    const title = $('meta[property="og:title"]').attr('content')?.split(' : ')[0]?.trim()
      || $('title').first().text().split(' : ')[0].trim()

    const priceText = $('meta[property="product:price:amount"]').attr('content')
    const price = priceText ? parseInt(priceText, 10) || null : null

    const description = $('meta[property="og:description"]').attr('content')?.trim() || ''

    const ogImage = $('meta[property="og:image"]').attr('content')
    const images = ogImage ? [ogImage] : []

    // パンくずリストのJSON-LDから、最も詳細なカテゴリ名を取得する。
    let category: string | null = null
    $('script[type="application/ld+json"]').each((_, el) => {
      if (category) return
      try {
        const data = JSON.parse($(el).text())
        if (data['@type'] === 'BreadcrumbList' && Array.isArray(data.itemListElement)) {
          const items = data.itemListElement as { item?: { name?: string } }[]
          const last = items[items.length - 1]
          if (last?.item?.name) category = last.item.name
        }
      } catch {
        // JSON解析に失敗した場合は無視して次のscriptタグを試す
      }
    })

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title: title ?? '',
      price,
      description,
      images,
      condition: null,
      category,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    }
  }
}
