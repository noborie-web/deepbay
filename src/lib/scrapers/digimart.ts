import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'

export class DigimartScraper extends BaseScraper {
  name = 'デジマート'
  siteKey = 'digimart'
  urlPattern = /digimart\.net\/cat1\/shop\d+\/[A-Za-z0-9]+\/?/

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/\/cat1\/shop\d+\/([A-Za-z0-9]+)\/?/)?.[1] ?? null

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

    const ogImage = $('meta[property="og:image"]').attr('content')
    const images = ogImage ? [ogImage] : []

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
