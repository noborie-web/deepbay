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
