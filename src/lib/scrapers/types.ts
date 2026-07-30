export interface ScrapedProduct {
  sourceUrl: string
  sourceSite: string
  sourceItemId: string | null
  title: string
  price: number | null
  description: string
  images: string[]
  condition: string | null
  category: string | null
  sellerId?: string | null        // 出品元サイトのセラー識別子
  sellerUrl?: string | null       // 出品元サイトのセラーページURL
  detailFetched?: boolean          // 個別商品詳細の取得に成功したか
  sourceStatus?: string | null     // 出品元サイトの商品状態（on_sale / trading / sold_out 等）
  sellerRatingCount: number | null  // 評価数
  shippingDays: number | null       // 発送日数（最短日数）
  sourceUpdatedAt: string | null    // 最終更新日（ISO文字列）
}

const SOLD_OUT_SOURCE_STATUSES = new Set([
  'sold_out',
  'status_sold_out',
])

export function isSoldOutSourceStatus(status: string | null | undefined): boolean {
  return status != null && SOLD_OUT_SOURCE_STATUSES.has(status.trim().toLowerCase())
}

export interface ScraperOptions {
  userAgent?: string
  timeoutMs?: number
  limit?: number  // 取得件数上限
  onPage?: (fetched: number, total: number) => void  // ページ取得後コールバック
}

export interface IScraper {
  name: string
  siteKey: string
  urlPattern: RegExp
  matches?(url: string): boolean
  // 単品 or 複数を統一してリストで返す
  scrape(url: string, options?: ScraperOptions): Promise<ScrapedProduct[]>
}

export class ScraperError extends Error {
  constructor(
    message: string,
    public readonly siteKey: string,
    public readonly url: string,
  ) {
    super(message)
    this.name = 'ScraperError'
  }
}
