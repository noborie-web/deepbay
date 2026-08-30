import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

interface VectorParkOffer {
  price?: string | number
  itemCondition?: string[] | string
  availability?: string
}

interface VectorParkProductJsonLd {
  name?: string
  description?: string[] | string
  image?: string[] | string
  brand?: { name?: string }
  offers?: VectorParkOffer
}

const SEARCH_URL_PATTERN = /vector-park\.jp\/list\//
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_SIZE = 180 // サイトが対応する最大表示件数

// 検索結果のサムネイルは小サイズ("images/item/thumb/{size}/…")のため、
// パスをoriginal2(元画像)に、サブドメインをimage.vector-park.jpに書き換える。
function upsizeImage(src: string): string {
  return src
    .replace(/\/\/image\d*\.vector-park\.jp\//, '//image.vector-park.jp/')
    .replace(/\/images\/item\/thumb\/\d+x\d+\//, '/images/item/original2/')
}

export class VectorParkScraper extends BaseScraper {
  name = 'ベクトルパーク'
  siteKey = 'vector_park'
  urlPattern = /vector-park\.jp\/item\/[^/]+\/?/

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
    baseUrl.searchParams.set('lm', String(PAGE_SIZE))

    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()
    let numFound: number | null = null
    // 暴走防止用の安全上限
    const maxPages = Math.ceil(limit / PAGE_SIZE) + 5

    for (let page = 1; page <= maxPages && allProducts.length < limit; page++) {
      if (page > 1) baseUrl.searchParams.set('p', String(page))
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
        const m = bodyText.match(/全\s*([\d,]+)\s*件/)
        if (m) numFound = parseInt(m[1].replace(/,/g, ''), 10)
      }

      const pageProducts: ScrapedProduct[] = []
      $('.list_area .item').each((_, el) => {
        const $el = $(el)
        const link = $el.find('.item_img a').first()
        const href = link.attr('href') ?? ''
        const itemId = href.match(/\/item\/([^/]+)\/?/)?.[1] ?? ''
        if (!itemId || seenIds.has(itemId)) return
        seenIds.add(itemId)

        const img = link.find('img').first()
        // 検索結果の商品名は末尾が省略されることがあるため、画像alt属性の
        // フルテキストを優先する。
        const title = img.attr('alt')?.trim() || $el.find('.item_nm a').first().text().trim()
        const priceText = $el.find('.item_pr').first().text().trim()
        const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null
        const imgSrc = img.attr('src') ?? ''
        const rankIconSrc = $el.find('.item_icn img[src*="rank_"]').first().attr('src') ?? ''
        const condition = rankIconSrc.match(/rank_([a-z0-9]+)\.gif/i)?.[1]?.toUpperCase() ?? null

        pageProducts.push({
          sourceUrl: href ? new URL(href, 'https://vector-park.jp').toString() : url,
          sourceSite: this.siteKey,
          sourceItemId: itemId,
          title,
          price,
          description: '',
          images: imgSrc ? [upsizeImage(imgSrc)] : [],
          condition,
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
    const itemId = url.match(/\/item\/([^/]+)\/?/)?.[1] ?? null

    const jsonLdBlocks = $('script[type="application/ld+json"]').toArray()
    const data: VectorParkProductJsonLd | undefined = jsonLdBlocks
      .map((el): VectorParkProductJsonLd | null => {
        try {
          const parsed = JSON.parse($(el).text())
          const candidate = Array.isArray(parsed) ? parsed[0] : parsed
          return candidate?.['@type'] === 'Product' ? (candidate as VectorParkProductJsonLd) : null
        } catch {
          return null
        }
      })
      .find((candidate): candidate is VectorParkProductJsonLd => candidate !== null)

    const title = data?.name?.trim() || $('title').first().text().split('|')[0].trim()

    const priceRaw = data?.offers?.price
    const price = priceRaw != null ? parseInt(String(priceRaw), 10) || null : null

    const descriptionValue = data?.description
    const description = Array.isArray(descriptionValue)
      ? descriptionValue.join('\n')
      : (descriptionValue ?? '')

    const imageValue = data?.image
    const images = Array.isArray(imageValue) ? imageValue : (imageValue ? [imageValue] : [])

    const conditionValue = data?.offers?.itemCondition
    const condition = Array.isArray(conditionValue) ? (conditionValue[0] ?? null) : (conditionValue ?? null)

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title,
      price,
      description,
      images,
      condition,
      category: data?.brand?.name ?? null,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    }
  }
}
