import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const SEARCH_URL_PATTERN = /fril\.jp\/s(?:\?|$)/
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_SIZE = 40

// 検索結果カードの画像はデフォルトでは中サイズ("/img/{id}/m/{file}")のため、
// パスの/m/を/l/(大サイズ)に書き換えて元画像に近いサイズを取得する。
function upsizeImage(src: string): string {
  return src.replace(/\/img\/(\d+)\/m\//, '/img/$1/l/')
}

export class RakumaScraper extends BaseScraper {
  name = 'ラクマ'
  siteKey = 'rakuma'
  // 現在の商品ページの実URL形式はitem.fril.jp/{hash} (サブドメイン)。
  // 旧形式のfril.jp/items/{id}やfril.jp/item/{id}も念のため受け付ける。
  urlPattern = /(?:item\.fril\.jp\/[a-zA-Z0-9]+|fril\.jp\/items?\/)/

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
      baseUrl.searchParams.set('page', String(page))
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

      const pageProducts: ScrapedProduct[] = []
      $('a[href*="item.fril.jp/"]').each((_, el) => {
        const $el = $(el)
        const href = $el.attr('href') ?? ''
        const itemId = href.match(/item\.fril\.jp\/([a-zA-Z0-9]+)/)?.[1] ?? ''
        if (!itemId) return

        if (numFound === null) {
          const totalRaw = $el.attr('data-rat-cp-totalresults')
          if (totalRaw) {
            const n = parseInt(totalRaw, 10)
            if (Number.isFinite(n)) numFound = n
          }
        }

        const title = $el.attr('data-rat-item_name')?.trim() ?? $el.attr('title')?.trim() ?? ''
        const priceRaw = $el.attr('data-rat-price')
        const price = priceRaw ? parseInt(priceRaw, 10) || null : null
        const imgSrc = $el.find('img').attr('data-original') ?? $el.find('img').attr('src') ?? ''

        pageProducts.push({
          sourceUrl: `https://item.fril.jp/${itemId}`,
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

    const limited = allProducts.slice(0, limit)

    // ラクマの検索結果カードには出品者情報が含まれないため(メルカリ・
    // ヤフオクと異なる)、危険セラー除外に出品者URLが必要な場合のみ、
    // 商品ごとに個別ページへアクセスして取得する(コストが大きいため
    // options.fetchSellerInfoが指定された時だけ実行する)。
    if (options.fetchSellerInfo) {
      return this.enrichSellerUrls(limited, userAgent, timeoutMs)
    }

    return limited
  }

  private async enrichSellerUrls(
    products: ScrapedProduct[],
    userAgent: string,
    timeoutMs: number,
  ): Promise<ScrapedProduct[]> {
    const concurrency = 8
    const enriched: ScrapedProduct[] = []

    for (let i = 0; i < products.length; i += concurrency) {
      const chunk = products.slice(i, i + concurrency)
      const results = await Promise.all(chunk.map(async (product) => {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const res = await fetch(product.sourceUrl, {
              headers: { 'User-Agent': userAgent, 'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3' },
              signal: controller.signal,
            })
            if (!res.ok) return product
            const html = await res.text()
            const $ = cheerio.load(html)
            const sellerUrl = $('a[href*="fril.jp/shop/"]').first().attr('href') ?? null
            return { ...product, sellerUrl }
          } finally {
            clearTimeout(timer)
          }
        } catch {
          // 出品者URL取得の失敗は抽出全体を止めない。sellerUrl未設定のまま返す
          // (=危険セラー判定の対象外になるだけで、商品自体は取得できる)。
          return product
        }
      }))
      enriched.push(...results)
    }

    return enriched
  }

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/item\.fril\.jp\/([a-zA-Z0-9]+)/)?.[1]
      ?? url.match(/items?\/([^/?]+)/)?.[1]
      ?? null

    // 優先: サイトのメタタグ・表組みから構造化データを取得する
    // (旧実装が依拠していた__NEXT_DATA__は現行ページには存在しないことを確認済み)。
    const title = $('meta[property="og:title"]').attr('content')?.replace(/\s*\|\s*フリマアプリ\s*ラクマ\s*$/, '').trim()
      || $('h1.item__name').first().text().trim()

    const priceText = $('.item__price').first().text().trim()
    const priceFromMeta = $('meta[property="product:price:amount"]').attr('content')
    const price = priceText
      ? (parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null)
      : (priceFromMeta ? parseInt(priceFromMeta, 10) || null : null)

    const description = $('.item__description__line-limited').first().text().trim()
      || $('meta[property="og:description"]').attr('content')?.trim()
      || ''

    // 商品の状態: 表組みの行から「商品の状態」ラベルの隣のtdを取得
    let condition: string | null = null
    $('th').each((_, el) => {
      if ($(el).text().trim() === '商品の状態') {
        condition = $(el).next('td').text().trim() || null
        return false
      }
    })

    // カテゴリ: パンくずリストの末尾
    const category = $('ul.breadcrumbs li a').last().text().trim() || null

    // 画像: この商品のIDフォルダに属する大サイズ("/l/")画像をすべて集める
    const retailerItemId = $('meta[property="product:retailer_item_id"]').attr('content') ?? itemId ?? ''
    const images: string[] = []
    if (retailerItemId) {
      const re = new RegExp(`https://img\\.fril\\.jp/img/${retailerItemId}/l/[0-9]+\\.jpg[^"'\\s]*`, 'g')
      const html = $.html()
      const matches = html.match(re) ?? []
      for (const m of matches) {
        if (!images.includes(m)) images.push(m)
      }
    }
    if (images.length === 0) {
      const ogImage = $('meta[property="og:image"]').attr('content')
      if (ogImage) images.push(ogImage)
    }

    // 発送日数: 「発送日の目安」行のテキストから最初の数字を取得
    let shippingDays: number | null = null
    $('th').each((_, el) => {
      if ($(el).text().trim() === '発送日の目安') {
        const text = $(el).next('td').text()
        const m = text.match(/(\d+)/)
        if (m) shippingDays = parseInt(m[1], 10)
        return false
      }
    })

    // 出品者評価数: 「取引の評価」セクション内の最初の数字
    let sellerRatingCount: number | null = null
    const evalIdx = $.html().indexOf('取引の評価')
    if (evalIdx !== -1) {
      const after = $.html().slice(evalIdx, evalIdx + 500)
      const m = after.match(/<span>(\d+)<\/span>/)
      if (m) sellerRatingCount = parseInt(m[1], 10)
    }

    // 危険セラー除外の個別商品判定用。実データ確認: 商品ページの
    // ショップ情報リンク(fril.jp/shop/{id})が出品者プロフィールURL。
    const sellerUrl = $('a[href*="fril.jp/shop/"]').first().attr('href') ?? null

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title: title ?? '',
      price,
      description,
      images,
      condition,
      category,
      sellerRatingCount,
      shippingDays,
      sourceUpdatedAt: null,
      sellerUrl,
    }
  }
}
