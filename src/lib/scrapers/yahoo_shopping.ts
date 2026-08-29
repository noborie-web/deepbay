import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'

export class YahooShoppingScraper extends BaseScraper {
  name = 'ヤフーショッピング'
  siteKey = 'yahoo_shopping'
  urlPattern = /store\.shopping\.yahoo\.co\.jp\/[^/]+\/[a-zA-Z0-9_.-]+\.html/

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    // URLは https://store.shopping.yahoo.co.jp/{ストアID}/{商品コード}.html の形式。
    // 商品コードをsourceItemIdとして使う（ストア内で一意）。
    const itemId = url.match(/store\.shopping\.yahoo\.co\.jp\/[^/]+\/([a-zA-Z0-9_.-]+)\.html/)?.[1] ?? null

    const title = $('meta[property="og:title"]').attr('content')?.split(' : ')[0]?.trim()
      || $('title').first().text().split(' : ')[0].trim()

    const priceText = $('meta[property="product:price:amount"]').attr('content')
    const price = priceText ? parseInt(priceText, 10) || null : null

    const description = $('meta[property="og:description"]').attr('content')?.trim() || ''

    const ogImage = $('meta[property="og:image"]').attr('content')
    const images = ogImage ? [ogImage] : []

    // パンくずリストのJSON-LDから、最も詳細なカテゴリ名を取得する。
    let category: string | null = null
    $('script[type="application/ld+json"]').each((_, el) => {
      if (category) return
      try {
        const data = JSON.parse($(el).text())
        if (data['@type'] === 'BreadcrumbList' && Array.isArray(data.itemListElement)) {
          const items = data.itemListElement as { item?: { name?: string } }[]
          const last = items[items.length - 1]
          if (last?.item?.name) category = last.item.name
        }
      } catch {
        // JSON解析に失敗した場合は無視して次のscriptタグを試す
      }
    })

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title: title ?? '',
      price,
      description,
      images,
      condition: null,
      category,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    }
  }
}
