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
}

export interface IScraper {
  name: string
  siteKey: string
  urlPattern: RegExp
  scrape(url: string, options?: ScraperOptions): Promise<ScrapedProduct>
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
