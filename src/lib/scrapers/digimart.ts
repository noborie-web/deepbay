import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const SEARCH_URL_PATTERN = /digimart\.net\/search/
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_SIZE = 100

function absoluteImageUrl(src: string): string {
  return src.startsWith('//') ? `https:${src}` : src
}

export class DigimartScraper extends BaseScraper {
  name = 'デジマート'
  siteKey = 'digimart'
  // カテゴリ番号は商品ごとに異なる2桁ゼロ埋め(cat01, cat16, cat21...)。
  // "cat1"固定は実際の検索結果ページのリンクとは一致しない(検証済み)。
  urlPattern = /digimart\.net\/cat\d+\/shop\d+\/[A-Za-z0-9]+\/?/

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
    baseUrl.searchParams.set('readCount', String(PAGE_SIZE))

    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()
    let numFound: number | null = null
    // 暴走防止用の安全上限
    const maxPages = Math.ceil(limit / PAGE_SIZE) + 5

    for (let page = 1; page <= maxPages && allProducts.length < limit; page++) {
      baseUrl.searchParams.set('currentPage', String(page))
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
        const m = bodyText.match(/該当\s*([\d,]+)\s*件/)
        if (m) numFound = parseInt(m[1].replace(/,/g, ''), 10)
      }

      const pageProducts: ScrapedProduct[] = []
      $('.itemSearchBlock').each((_, el) => {
        const $el = $(el)
        const link = $el.find('p.ttl a[href*="/shop"]').first()
        const href = link.attr('href') ?? ''
        const itemId = $el.attr('data-instrument-cd')
          || href.match(/\/cat\d+\/shop\d+\/([A-Za-z0-9]+)\/?/)?.[1]
          || ''
        if (!itemId) return

        const title = link.text().trim()
        const priceText = $el.find('p.price').first().text().trim()
        const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null
        const condition = $el.find('p.state span.tooltip').first().text().trim() || null
        const imgSrc = $el.find('.pic img').first().attr('src') ?? ''

        pageProducts.push({
          sourceUrl: href ? new URL(href, 'https://www.digimart.net').toString() : url,
          sourceSite: this.siteKey,
          sourceItemId: itemId,
          title,
          price,
          description: '',
          images: imgSrc ? [absoluteImageUrl(imgSrc)] : [],
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

      for (const p of pageProducts) {
        if (!seenIds.has(p.sourceItemId!)) {
          seenIds.add(p.sourceItemId!)
          allProducts.push(p)
        }
      }
      onPage?.(allProducts.length, numFound ?? limit)

      if (numFound !== null && allProducts.length >= numFound) break
    }

    if (allProducts.length === 0) {
      throw new ScraperError('検索結果が0件です', this.siteKey, url)
    }

    return allProducts.slice(0, limit)
  }

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/\/cat\d+\/shop\d+\/([A-Za-z0-9]+)\/?/)?.[1] ?? null

    // og:titleは「ブランド／型番等／状態区分／価格／状態：ランク」の全角スラッシュ区切り。
    // 末尾の状態区分・価格・状態ランクの3項目を除いた前半（ブランド+型番）を商品名とする。
    const ogTitle = $('meta[property="og:title"]').attr('content') ?? ''
    const titleParts = ogTitle.split('／').map((p) => p.trim()).filter(Boolean)
    const title = titleParts.length > 3
      ? titleParts.slice(0, -3).join(' ')
      : (titleParts[0] || $('title').first().text().split('【')[0]).trim()

    const priceText = $('p.price').first().text().trim()
    const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null

    const condition = $('p.state span.tooltip').first().text().trim() || null

    const description = $('meta[name="description"]').attr('content')?.trim()
      || $('meta[property="og:description"]').attr('content')?.trim()
      || ''

    const category = $('meta[name="keywords"]').attr('content')?.split(',')[0]?.trim() || null

    // 商品詳細ページのフォトエリアから全画像を取得する(og:imageのみでは
    // メイン画像1枚しか取れない)。取得できない場合はog:imageにフォールバック。
    const images: string[] = []
    $('.itemPhotoArea a.cbx').each((_, el) => {
      const href = $(el).attr('href')
      if (href) {
        const abs = absoluteImageUrl(href)
        if (!images.includes(abs)) images.push(abs)
      }
    })
    if (images.length === 0) {
      const ogImage = $('meta[property="og:image"]').attr('content')
      if (ogImage) images.push(ogImage)
    }

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title,
      price,
      description,
      images,
      condition,
      category,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    }
  }
}
