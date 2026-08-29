import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'

export class BrandOffScraper extends BaseScraper {
  name = 'ブランドオフ'
  siteKey = 'brandoff'
  urlPattern = /brandoff-store\.com\/Form\/Product\/ProductDetail\.aspx\?[^#]*\bpid=\d+/

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
