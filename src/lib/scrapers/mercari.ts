import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'
import { ScraperError } from './types'

export class MercariScraper extends BaseScraper {
  name = 'メルカリ'
  siteKey = 'mercari'
  urlPattern = /mercari\.com\/(jp\/items|item)\//

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    // メルカリはNext.jsのSSRページ — __NEXT_DATA__からJSONで取得
    const nextDataEl = $('#__NEXT_DATA__').text()
    if (!nextDataEl) {
      throw new ScraperError('__NEXT_DATA__ not found', this.siteKey, url)
    }

    let data: Record<string, unknown>
    try {
      data = JSON.parse(nextDataEl)
    } catch {
      throw new ScraperError('Failed to parse __NEXT_DATA__', this.siteKey, url)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = (data as any)?.props?.pageProps?.item
    if (!item) {
      throw new ScraperError('Item data not found in page', this.siteKey, url)
    }

    const itemId = url.match(/items\/([^/?]+)/)?.[1] ?? null

    const images: string[] = (item.photos ?? []).map(
      (p: { image_url?: string; imageUrl?: string }) => p.image_url ?? p.imageUrl ?? ''
    ).filter(Boolean)

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title: item.name ?? '',
      price: typeof item.price === 'number' ? item.price : null,
      description: item.description ?? '',
      images,
      condition: item.item_condition?.name ?? item.itemCondition?.name ?? null,
      category: item.item_category?.name ?? item.itemCategory?.name ?? null,
    }
  }
}
