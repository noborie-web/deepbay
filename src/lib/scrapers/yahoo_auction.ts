import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const SEARCH_URL_PATTERN = /auctions\.yahoo\.co\.jp\/search\/search/
const SELLER_URL_PATTERN = /auctions\.yahoo\.co\.jp\/seller\/[^/?#]+/
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_SIZE = 50

// 検索結果のサムネイルはデフォルトでは小さい(w=300&h=300)ため、
// 画像URLのリサイズ指定を大きい値に書き換えて元画像に近いサイズを取得する。
function upsizeImage(src: string): string {
  return src.replace(/([?&])w=\d+/, '$1w=1200').replace(/([?&])h=\d+/, '$1h=1200')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface YahooAuctionNextDataItem { [key: string]: any }

function extractNextDataItem($: cheerio.CheerioAPI): YahooAuctionNextDataItem | null {
  const nextDataText = $('#__NEXT_DATA__').text()
  if (!nextDataText) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nd: any = JSON.parse(nextDataText)
    return nd?.props?.pageProps?.initialState?.item?.detail?.item ?? null
  } catch {
    return null
  }
}

export class YahooAuctionScraper extends BaseScraper {
  name = 'ヤフオク'
  siteKey = 'yahoo_auction'
  // 現在の商品ページの実URL形式は /jp/auction/{id}。旧形式 /item/{id} も
  // 念のため受け付けるが、現時点では404になることを確認済み。
  urlPattern = /auctions\.yahoo\.co\.jp\/(?:item\/|jp\/auction\/)/

  matches(url: string): boolean {
    return this.urlPattern.test(url) || SEARCH_URL_PATTERN.test(url) || SELLER_URL_PATTERN.test(url)
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    if (SEARCH_URL_PATTERN.test(url)) {
      return this.scrapeSearch(url, options)
    }
    if (SELLER_URL_PATTERN.test(url)) {
      return this.scrapeSeller(url, options)
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

    for (let page = 0; page < maxPages && allProducts.length < limit; page++) {
      const offset = page * PAGE_SIZE + 1 // ヤフオクの`b`パラメータは1始まり
      baseUrl.searchParams.set('b', String(offset))
      baseUrl.searchParams.set('n', String(PAGE_SIZE))
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
        const headerText = $('.Result__header').first().text()
        const m = headerText.match(/([\d,]+)\s*件/)
        if (m) numFound = parseInt(m[1].replace(/,/g, ''), 10)
      }

      const pageProducts: ScrapedProduct[] = []
      $('a.Product__imageLink[data-auction-id]').each((_, el) => {
        const $el = $(el)
        const itemId = $el.attr('data-auction-id') ?? ''
        if (!itemId) return
        const title = $el.attr('data-auction-title')?.trim() ?? ''
        const priceRaw = $el.attr('data-auction-price')
        const price = priceRaw ? parseInt(priceRaw, 10) || null : null
        const imgSrc = $el.attr('data-auction-img') ?? ''
        pageProducts.push({
          sourceUrl: `https://auctions.yahoo.co.jp/jp/auction/${itemId}`,
          sourceSite: this.siteKey,
          sourceItemId: itemId,
          title,
          price,
          description: '',
          images: imgSrc ? [upsizeImage(imgSrc)] : [],
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

  // セラーページ(出品者の出品一覧)の抽出。検索ページと違い商品カードに
  // data-auction-*属性が無く、代わりに__NEXT_DATA__内の
  // initialState.search.items.listing.{items,totalResultsAvailable}に
  // 構造化データ(価格・カテゴリ・状態コード・終了日時まで含む)が
  // 埋め込まれているため、それを使う。ページネーションのb/nパラメータは
  // 検索ページと共通(実データで別ページの異なる商品が返ることを確認済み)。
  private async scrapeSeller(url: string, options: ScraperOptions): Promise<ScrapedProduct[]> {
    const { userAgent = DEFAULT_UA, timeoutMs = 15000, limit = 600, onPage } = options
    const baseUrl = new URL(url)

    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()
    let numFound: number | null = null
    // 暴走防止用の安全上限
    const maxPages = Math.ceil(limit / PAGE_SIZE) + 5

    for (let page = 0; page < maxPages && allProducts.length < limit; page++) {
      const offset = page * PAGE_SIZE + 1 // ヤフオクの`b`パラメータは1始まり
      baseUrl.searchParams.set('b', String(offset))
      baseUrl.searchParams.set('n', String(PAGE_SIZE))
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
      let listing: YahooAuctionNextDataItem | null = null
      try {
        const nd = JSON.parse($('#__NEXT_DATA__').text())
        listing = nd?.props?.pageProps?.initialState?.search?.items?.listing ?? null
      } catch {
        listing = null
      }

      if (numFound === null && typeof listing?.totalResultsAvailable === 'number') {
        numFound = listing.totalResultsAvailable
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawItems: any[] = Array.isArray(listing?.items) ? listing.items : []
      const pageProducts: ScrapedProduct[] = []
      for (const item of rawItems) {
        const itemId: string | undefined = item?.auctionId
        if (!itemId) continue

        const categoryPath = item?.categoryPath
        const category = Array.isArray(categoryPath) && categoryPath.length > 0
          ? categoryPath[categoryPath.length - 1]?.name ?? null
          : (item?.category?.name ?? null)

        let sourceUpdatedAt: string | null = null
        if (typeof item?.endTime === 'string') {
          const d = new Date(item.endTime)
          if (isFinite(d.getTime())) sourceUpdatedAt = d.toISOString()
        }

        pageProducts.push({
          sourceUrl: `https://auctions.yahoo.co.jp/jp/auction/${itemId}`,
          sourceSite: this.siteKey,
          sourceItemId: itemId,
          title: typeof item?.title === 'string' ? item.title : '',
          price: typeof item?.price === 'number' ? item.price : null,
          description: '',
          images: typeof item?.imageUrl === 'string' ? [upsizeImage(item.imageUrl)] : [],
          condition: typeof item?.itemCondition === 'string' ? item.itemCondition : null,
          category,
          sellerRatingCount: null,
          shippingDays: null,
          sourceUpdatedAt,
        })
      }

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
      throw new ScraperError('出品者の商品が0件です', this.siteKey, url)
    }

    return allProducts.slice(0, limit)
  }

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/(?:item|jp\/auction)\/([^/?]+)/)?.[1] ?? null

    // 優先: Next.jsの__NEXT_DATA__に埋め込まれた構造化データを使う。
    // サイトのCSSクラス名はリニューアルで頻繁に変わるため信頼性が低い
    // (実際、旧セレクタは現行ページでは一致しなくなっていることを確認済み)。
    const nextItem = extractNextDataItem($)
    if (nextItem && (nextItem.title || nextItem.price != null)) {
      const images: string[] = Array.isArray(nextItem.img)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? nextItem.img.map((im: any) => im?.image).filter((s: unknown): s is string => typeof s === 'string' && s.length > 0)
        : []

      const categoryPath = nextItem.category?.path
      const category = Array.isArray(categoryPath) && categoryPath.length > 0
        ? categoryPath[categoryPath.length - 1]?.name ?? null
        : null

      const description = Array.isArray(nextItem.description)
        ? nextItem.description.join('\n').trim()
        : (typeof nextItem.descriptionHtml === 'string'
            ? nextItem.descriptionHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
            : '')

      let shippingDays: number | null = null
      if (typeof nextItem.shipScheduleName === 'string') {
        const m = nextItem.shipScheduleName.match(/(\d+)\s*[~〜～]?\s*\d*\s*日/)
        if (m) shippingDays = parseInt(m[1], 10)
      }

      const sellerRatingCount: number | null = typeof nextItem.seller?.rating?.summary === 'number'
        ? nextItem.seller.rating.summary
        : (typeof nextItem.seller?.rating?.ult?.allPoint === 'number' ? nextItem.seller.rating.ult.allPoint : null)

      let sourceUpdatedAt: string | null = null
      if (typeof nextItem.endTime === 'string') {
        const d = new Date(nextItem.endTime)
        if (isFinite(d.getTime())) sourceUpdatedAt = d.toISOString()
      }

      return {
        sourceUrl: url,
        sourceSite: this.siteKey,
        sourceItemId: nextItem.auctionId ?? itemId,
        title: nextItem.title ?? '',
        price: typeof nextItem.price === 'number' ? nextItem.price : null,
        description,
        images,
        condition: nextItem.conditionName ?? null,
        category,
        sellerRatingCount,
        shippingDays,
        sourceUpdatedAt,
      }
    }

    // フォールバック: __NEXT_DATA__が取得できない場合はCSSセレクタで頑張る
    // (サイト構造の変化で機能しなくなる可能性が高いが、無いよりはまし)。
    const title = $('h1.ProductTitle__text').first().text().trim()
      || $('h1[class*="Title"]').first().text().trim()
      || $('title').text().replace(' - ヤフオク!', '').trim()

    const priceText = $('.Price__value').first().text().trim()
      || $('[class*="Price"]').first().text().trim()
    const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null

    const description = $('#ProductExplanation__commentBody').text().trim()
      || $('[class*="Description"]').text().trim()

    const images: string[] = []
    $('img[class*="ProductImage"], .ProductImageArea img').each((_, el) => {
      const src = $(el).attr('src') ?? $(el).attr('data-src') ?? ''
      if (src && !src.includes('transparent') && !images.includes(src)) {
        // ヤフオクのサムネイルURLをオリジナルサイズに変換
        images.push(src.replace(/^(.+?)\?.*$/, '$1').replace('_m.jpg', '.jpg'))
      }
    })

    const condition = $('[class*="Condition"] .ProductDetail__description').first().text().trim() || null
    const category = $('ol.Breadcrumb__list li').last().text().trim() || null

    // 評価数: "総合評価 XXX" or "評価 XXX"
    let sellerRatingCount: number | null = null
    $('[class*="Seller"], [class*="seller"]').each((_, el) => {
      const text = $(el).text()
      const m = text.match(/評価[^\d]*(\d+)/)
      if (m) { sellerRatingCount = parseInt(m[1], 10); return false }
    })

    // 発送日数: "発送まで X日" or "X日以内に発送"
    let shippingDays: number | null = null
    $('[class*="Ship"], [class*="ship"], [class*="Delivery"]').each((_, el) => {
      const text = $(el).text()
      const m = text.match(/(\d+)\s*日/)
      if (m) { shippingDays = parseInt(m[1], 10); return false }
    })
    if (!shippingDays) {
      const bodyText = $('body').text()
      const m = bodyText.match(/発送まで.*?(\d+)\s*日/)
      if (m) shippingDays = parseInt(m[1], 10)
    }

    // 最終更新日: __NEXT_DATA__ から取得を試みる
    let sourceUpdatedAt: string | null = null
    const nextDataText = $('#__NEXT_DATA__').text()
    if (nextDataText) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nd: any = JSON.parse(nextDataText)
        const item = nd?.props?.pageProps?.initialState?.auction?.item
          ?? nd?.props?.pageProps?.item
          ?? null
        const raw = item?.end_time ?? item?.endTime ?? item?.updated ?? item?.updatedAt ?? null
        if (raw) sourceUpdatedAt = new Date(typeof raw === 'number' ? raw * 1000 : raw).toISOString()
      } catch { /* ignore */ }
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
      sellerRatingCount,
      shippingDays,
      sourceUpdatedAt,
    }
  }
}
