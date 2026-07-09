import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'

export class YahooAuctionScraper extends BaseScraper {
  name = 'ヤフオク'
  siteKey = 'yahoo_auction'
  urlPattern = /auctions\.yahoo\.co\.jp\/item\//

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/item\/([^/?]+)/)?.[1] ?? null

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

    // 価格タイプ: 即決価格のみ → fixed、入札あり → auction
    // __NEXT_DATA__ から type を確認、なければ HTML テキストで判断
    let priceType: 'fixed' | 'auction' = 'auction'
    if (nextDataText) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nd: any = JSON.parse(nextDataText)
        const item = nd?.props?.pageProps?.initialState?.auction?.item ?? nd?.props?.pageProps?.item ?? null
        const auctionType = item?.auction_type ?? item?.auctionType ?? item?.type ?? null
        if (auctionType === 'fixed' || auctionType === 'buy_it_now') priceType = 'fixed'
      } catch { /* ignore */ }
    }
    // HTML テキストで判断: 「入札」がなく「即決」があれば fixed
    if (priceType === 'auction') {
      const bodyText = $('body').text()
      if (bodyText.includes('即決') && !bodyText.includes('入札')) priceType = 'fixed'
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
      priceType,
    }
  }
}
