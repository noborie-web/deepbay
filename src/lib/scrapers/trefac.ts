import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

interface TrefacOffer {
  price?: string | number
  itemCondition?: string
}

interface TrefacProductJsonLd {
  name?: string
  description?: string
  image?: string[] | string
  brand?: { name?: string }
  offers?: TrefacOffer
}

const CONDITION_LABELS: Record<string, string> = {
  'http://schema.org/UsedCondition': '中古',
  'https://schema.org/UsedCondition': '中古',
  'http://schema.org/NewCondition': '新品',
  'https://schema.org/NewCondition': '新品',
}

const SEARCH_URL_PATTERN = /trefac\.jp\/store\/search_result\.html/
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_SIZE = 90 // 実データで確認したサイト側の1ページあたり件数

// 検索結果のサムネイルは"/w{数値}/"というリサイズ用パスセグメントが
// 挿入されているため、これを除去して元画像(単品ページのJSON-LDと同じ
// URL形式)を取得する。
function upsizeImage(src: string): string {
  return src.replace(/\/w\d+\//, '/')
}

export class TrefacScraper extends BaseScraper {
  name = 'トレファクファッション'
  siteKey = 'trefac'
  urlPattern = /trefac\.jp\/store\/[^/]+\/[^/]+\/?/

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
    // 暴走防止用の安全上限
    const maxPages = Math.ceil(limit / PAGE_SIZE) + 5

    for (let page = 1; page <= maxPages && allProducts.length < limit; page++) {
      if (page > 1) baseUrl.searchParams.set('key', String(page))
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
        const totalText = $('.search_result_num').first().text().trim()
        if (totalText) {
          const n = parseInt(totalText.replace(/,/g, ''), 10)
          if (Number.isFinite(n)) numFound = n
        }
      }

      const pageProducts: ScrapedProduct[] = []
      $('li.p-itemlist_item').each((_, el) => {
        const $el = $(el)
        const link = $el.find('a.p-itemlist_btn').first()
        const href = link.attr('href') ?? ''
        const itemId = href.match(/\/store\/[^/]+\/(c\d+)\/?/)?.[1] ?? ''
        if (!itemId || seenIds.has(itemId)) return
        seenIds.add(itemId)

        const brand = $el.find('.p-itemlist_brand').first().text().trim()
        const alt = link.find('img').attr('alt') ?? ''
        // alt属性は「ブランド）の古着「商品名」｜色」という形式なので、
        // 「」内の商品名を抽出してブランド名と組み合わせる。
        const nameMatch = alt.match(/「([^」]+)」/)
        const title = nameMatch ? `${brand} ${nameMatch[1]}`.trim() : (alt || brand)

        // 価格のクラス名は通常価格(p-price2_a)とセール価格(p-price2_b)で
        // 異なる(実データで確認済み)ため、両方を許容する。
        const priceText = $el.find('[class^="p-price2_"]').first().text().trim()
        const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null
        const imgSrc = link.find('img').attr('src') ?? ''

        pageProducts.push({
          sourceUrl: href ? new URL(href, 'https://www.trefac.jp').toString() : url,
          sourceSite: this.siteKey,
          sourceItemId: itemId,
          title,
          price,
          description: '',
          images: imgSrc ? [upsizeImage(imgSrc)] : [],
          condition: null,
          category: brand || null,
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
    const itemId = url.match(/\/store\/[^/]+\/([^/]+)\/?/)?.[1] ?? null

    const jsonLdBlocks = $('script[type="application/ld+json"]').toArray()
    const data: TrefacProductJsonLd | undefined = jsonLdBlocks
      .map((el): TrefacProductJsonLd | null => {
        try {
          const parsed = JSON.parse($(el).text())
          const candidate = Array.isArray(parsed) ? parsed[0] : parsed
          return candidate?.['@type'] === 'Product' ? (candidate as TrefacProductJsonLd) : null
        } catch {
          return null
        }
      })
      .find((candidate): candidate is TrefacProductJsonLd => candidate !== null)

    const title = data?.name?.trim()
      || $('meta[property="og:title"]').attr('content')?.trim()
      || ''

    const priceRaw = data?.offers?.price
    const price = priceRaw != null ? parseInt(String(priceRaw), 10) || null : null

    const description = data?.description?.trim() || ''

    const imageValue = data?.image
    const images = Array.isArray(imageValue) ? imageValue : (imageValue ? [imageValue] : [])

    const conditionUrl = data?.offers?.itemCondition
    const condition = conditionUrl ? (CONDITION_LABELS[conditionUrl] ?? null) : null

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
