import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'

export class RakumaScraper extends BaseScraper {
  name = 'ラクマ'
  siteKey = 'rakuma'
  urlPattern = /fril\.jp\/items\//

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/items\/([^/?]+)/)?.[1] ?? null

    // ラクマもNext.js — __NEXT_DATA__を試みる
    const nextDataEl = $('#__NEXT_DATA__').text()
    if (nextDataEl) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = JSON.parse(nextDataEl)
        const item = data?.props?.pageProps?.item ?? data?.props?.pageProps?.itemDetail?.item
        if (item) {
          return {
            sourceUrl: url,
            sourceSite: this.siteKey,
            sourceItemId: itemId,
            title: item.name ?? '',
            price: item.price ?? null,
            description: item.description ?? '',
            images: (item.item_images ?? []).map((i: { image_url?: string }) => i.image_url ?? '').filter(Boolean),
            condition: item.item_condition?.name ?? null,
            category: item.item_category?.name ?? null,
            sellerRatingCount: null,
            shippingDays: null,
            sourceUpdatedAt: null,
    priceType: 'fixed' as const,
          }
        }
      } catch {
        // フォールバックへ
      }
    }

    // フォールバック: HTML直接パース
    const title = $('h1').first().text().trim()
    const priceText = $('[class*="price"]').first().text().trim()
    const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null
    const description = $('[class*="description"]').first().text().trim()
    const images: string[] = []
    $('[class*="item-image"] img, [class*="ItemImage"] img').each((_, el) => {
      const src = $(el).attr('src') ?? ''
      if (src) images.push(src)
    })

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title,
      price,
      description,
      images,
      condition: null,
      category: null,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    priceType: 'fixed' as const,
    }
  }
}
