import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Origin': 'https://jp.mercari.com',
  'Referer': 'https://jp.mercari.com/',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProduct(item: any, url: string): ScrapedProduct {
  const itemId: string = item.id ?? item.item_id ?? ''
  const images: string[] = (item.thumbnails ?? item.photos ?? [])
    .map((p: string | { imageUrl?: string; image_url?: string }) =>
      typeof p === 'string' ? p : (p.imageUrl ?? p.image_url ?? '')
    )
    .filter(Boolean)

  // 評価数: seller情報から複数パスを試みる
  const seller = item.seller ?? item.sellerInfo ?? null
  let sellerRatingCount: number | null = null
  if (seller) {
    // num_ratings が直接ある場合
    if (typeof seller.num_ratings === 'number') sellerRatingCount = seller.num_ratings
    // ratings オブジェクトがある場合 → good + bad の合計
    else if (seller.ratings) {
      const g = seller.ratings.good ?? 0
      const b = seller.ratings.bad ?? 0
      if (g + b > 0) sellerRatingCount = g + b
    }
    // evaluation_count / ratingCount
    else if (typeof seller.evaluation_count === 'number') sellerRatingCount = seller.evaluation_count
    else if (typeof seller.ratingCount === 'number') sellerRatingCount = seller.ratingCount
  }

  // 発送日数: shipping_duration から取得
  // APIレスポンス例: { min: 1, max: 2 } または "1~2日で発送"
  const sd = item.shipping_duration ?? item.shippingDuration ?? item.shipping_payer ?? null
  let shippingDays: number | null = null
  if (sd && typeof sd === 'object') {
    if (typeof sd.min === 'number') shippingDays = sd.min
    else if (typeof sd.max === 'number') shippingDays = sd.max
  } else if (typeof sd === 'string') {
    const m = sd.match(/(\d+)/)
    if (m) shippingDays = parseInt(m[1], 10)
  }
  // フォールバック: shipping_duration_days
  if (shippingDays === null && typeof item.shipping_duration_days === 'number') {
    shippingDays = item.shipping_duration_days
  }

  // 最終更新日: Unix秒またはISO文字列
  const updatedRaw = item.updated ?? item.updated_at ?? item.updatedAt ?? item.created ?? null
  const sourceUpdatedAt: string | null = updatedRaw
    ? new Date(typeof updatedRaw === 'number' ? updatedRaw * 1000 : updatedRaw).toISOString()
    : null

  return {
    sourceUrl: `https://jp.mercari.com/item/${itemId}`,
    sourceSite: 'mercari',
    sourceItemId: itemId,
    title: item.name ?? '',
    price: typeof item.price === 'number' ? item.price : null,
    description: item.description ?? '',
    images,
    condition: item.item_condition?.name ?? item.itemCondition?.name ?? null,
    category: item.item_category?.name ?? item.itemCategory?.name ?? null,
    sellerRatingCount,
    shippingDays,
    sourceUpdatedAt,
  }
}

export class MercariScraper {
  name = 'メルカリ'
  siteKey = 'mercari'
  urlPattern = /mercari\.com\/(jp\/items|item|s)\/[^/?#]+/

  matches(url: string): boolean {
    return this.urlPattern.test(url)
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    const { limit = 100 } = options

    // セラーページ: jp.mercari.com/s/{sellerId}
    const sellerMatch = url.match(/mercari\.com\/s\/([^/?#]+)/)
    if (sellerMatch) {
      return this.scrapeSellerPage(sellerMatch[1], url, limit)
    }

    // 単品ページ: jp.mercari.com/item/{itemId}
    const itemMatch = url.match(/\/(?:items\/|item\/)([^/?#]+)/)
    if (itemMatch) {
      const product = await this.scrapeItem(itemMatch[1], url)
      return [product]
    }

    throw new ScraperError('Invalid Mercari URL', this.siteKey, url)
  }

  private async scrapeSellerPage(sellerId: string, url: string, limit: number): Promise<ScrapedProduct[]> {
    const params = new URLSearchParams({
      seller_id: sellerId,
      status: 'on_sale',
      limit: String(Math.min(limit, 120)),
      offset: '0',
    })

    const res = await fetch(`https://api.mercari.jp/v2/entities/@${sellerId}/items?${params}`, {
      headers: HEADERS,
    })

    if (!res.ok) {
      // フォールバック: 検索APIで試す
      return this.scrapeSellerViaSearch(sellerId, url, limit)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    const items: unknown[] = json?.data ?? json?.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return this.scrapeSellerViaSearch(sellerId, url, limit)
    }

    return items.map((item) => toProduct(item, url))
  }

  private async scrapeSellerViaSearch(sellerId: string, url: string, limit: number): Promise<ScrapedProduct[]> {
    const body = JSON.stringify({
      sellerId,
      status: 'STATUS_TRADING',
      limit,
      offset: 0,
    })

    const res = await fetch('https://api.mercari.jp/v2/entities/search', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body,
    })

    if (!res.ok) {
      throw new ScraperError(`Seller API error: ${res.status}`, this.siteKey, url)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    const items: unknown[] = json?.data ?? json?.items ?? []

    if (!Array.isArray(items) || items.length === 0) {
      throw new ScraperError('No items found for this seller', this.siteKey, url)
    }

    return items.map((item) => toProduct(item, url))
  }

  private async scrapeItem(itemId: string, url: string): Promise<ScrapedProduct> {
    const res = await fetch(`https://api.mercari.jp/v1/items/get_items_by_id?id=${itemId}`, {
      headers: HEADERS,
    })

    if (!res.ok) {
      throw new ScraperError(`Item API error: ${res.status}`, this.siteKey, url)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    const item = json?.data ?? json?.item ?? json

    if (!item?.name) {
      throw new ScraperError('Item data not found', this.siteKey, url)
    }

    return toProduct(item, url)
  }
}
