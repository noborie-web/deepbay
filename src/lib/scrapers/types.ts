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
