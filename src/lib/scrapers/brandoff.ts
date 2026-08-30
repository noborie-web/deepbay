import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const SEARCH_URL_PATTERN = /brandoff-store\.com\/Form\/Product\/ProductList\.aspx/
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_SIZE = 90

// 検索結果カードの画像は"_L."(370x370)止まりなので、"_LL."(600x600)に
// 書き換えて単品ページと同じ大サイズを取得する。
function upsizeImage(src: string): string {
  return src.replace(/_L\.(jpg|png)$/i, '_LL.$1')
}

export class BrandOffScraper extends BaseScraper {
  name = 'ブランドオフ'
  siteKey = 'brandoff'
  urlPattern = /brandoff-store\.com\/Form\/Product\/ProductDetail\.aspx\?[^#]*\bpid=\d+/

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
    baseUrl.searchParams.set('limit', String(PAGE_SIZE))

    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()
    let numFound: number | null = null
    // 暴走防止用の安全上限
    const maxPages = Math.ceil(limit / PAGE_SIZE) + 5

    for (let page = 0; page < maxPages && allProducts.length < limit; page++) {
      baseUrl.searchParams.set('o', String(page * PAGE_SIZE))
      const pageUrl = baseUrl.toString()

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let html: string
      try {
        const res = await fetch(pageUrl, {
          headers: { 'User-Agent': userAgent, 'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3' },
          signal: controller.signal,
        })
        if (!res.ok) {
          if (page === 0) throw new ScraperError(`HTTP ${res.status}: ${res.statusText}`, this.siteKey, url)
          break
        }
        html = await res.text()
      } catch (err) {
        if (page === 0) {
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

      const pageProducts: ScrapedProduct[] = []
      $('.product__item').each((_, el) => {
        const $el = $(el)
        const href = $el.find('a[href*="ProductDetail.aspx"]').first().attr('href') ?? ''
        const itemId = href.match(/[?&]pid=(\d+)/)?.[1] ?? ''
        if (!itemId || seenIds.has(itemId)) return
        seenIds.add(itemId)

        const title = $el.find('.product__item--name').first().text().trim()
        const priceText = $el.find('.product__price--numeric').first().text().trim()
        const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null
        const imgSrc = $el.find('img').first().attr('src') ?? ''

        pageProducts.push({
          sourceUrl: href ? new URL(href, 'https://www.brandoff-store.com').toString() : url,
          sourceSite: this.siteKey,
          sourceItemId: itemId,
          title,
          price,
          description: '',
          images: imgSrc ? [upsizeImage(new URL(imgSrc, 'https://www.brandoff-store.com').toString())] : [],
          condition: null,
          category: null,
          sellerRatingCount: null,
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
    const itemId = url.match(/[?&]pid=(\d+)/)?.[1] ?? null

    const title = $('h2.product__desc--name').first().text().trim()
      || $('h2.product-detail__float--product-name').first().text().trim()
      || $('title').first().text().split('｜')[0].trim()

    const priceText = $('.product__price--numeric').first().text().trim()
    const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null

    // 「商品状態：」の直後に、画像のalt属性(例: "RANK A")として状態ランクが入っている
    let condition: string | null = null
    $('dt').each((_, el) => {
      if (condition) return
      if ($(el).text().includes('商品状態')) {
        const alt = $(el).next('dd').find('img').attr('alt')
        if (alt) condition = alt.trim()
      }
    })

    const images = Array.from(new Set(
      $('img[src*="/Contents/ProductImages/"]')
        .map((_, el) => $(el).attr('src') ?? '')
        .get()
        .filter(Boolean)
        .map((src) => (src.startsWith('http') ? src : `https://www.brandoff-store.com${src}`))
        .filter((src) => /_LL\.(jpg|png)$/i.test(src)),
    ))

    // <title>は「ブランド名(英語表記)商品名｜商品番号｜...」の形式。
    // 最初の"("より前をブランド名(カテゴリとして使用)とする。
    const titleTag = $('title').first().text()
    const category = titleTag.split('(')[0].trim() || null

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title,
      price,
      description: '',
      images,
      condition,
      category,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    }
  }
}
