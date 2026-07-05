import { ScraperError } from './types'
import type { ScrapedProduct } from './types'

export class MercariScraper {
  name = 'メルカリ'
  siteKey = 'mercari'
  urlPattern = /mercari\.com\/(jp\/items|item)\//

  matches(url: string): boolean {
    return this.urlPattern.test(url)
  }

  async scrape(url: string): Promise<ScrapedProduct> {
    const itemId = url.match(/\/(?:items\/|item\/)([^/?#]+)/)?.[1]
    if (!itemId) {
      throw new ScraperError('Invalid Mercari URL', this.siteKey, url)
    }

    const apiUrl = `https://api.mercari.jp/v2/entities/${itemId}`
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'mercari-app/6.0.0 (iOS; iPhone)',
        'Accept': 'application/json',
        'Accept-Language': 'ja-JP',
        'X-Platform': 'ios',
        'X-App-Version': '6.0.0',
      },
    })

    if (!res.ok) {
      throw new ScraperError(`API error: ${res.status}`, this.siteKey, url)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    const item = json?.data ?? json?.item ?? json

    if (!item || !item.name) {
      throw new ScraperError('Item data not found in API response', this.siteKey, url)
    }

    const images: string[] = (item.photos ?? item.thumbnails ?? [])
      .map((p: { image_url?: string; imageUrl?: string } | string) =>
        typeof p === 'string' ? p : (p.image_url ?? p.imageUrl ?? '')
      )
      .filter(Boolean)

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
