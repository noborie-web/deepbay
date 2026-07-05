import type { IScraper, ScrapedProduct, ScraperOptions } from './types'
import { ScraperError } from './types'
import { MercariScraper } from './mercari'
import { YahooAuctionScraper } from './yahoo_auction'
import { RakumaScraper } from './rakuma'

// 新サイトを追加する場合はここにimportして追加するだけ
const SCRAPERS: IScraper[] = [
  new MercariScraper(),
  new YahooAuctionScraper(),
  new RakumaScraper(),
]

export function findScraper(url: string): IScraper | null {
  return SCRAPERS.find((s) => s.urlPattern.test(url)) ?? null
}

export function getSupportedSites(): { name: string; siteKey: string; urlPattern: string }[] {
  return SCRAPERS.map((s) => ({
    name: s.name,
    siteKey: s.siteKey,
    urlPattern: s.urlPattern.source,
  }))
}

export async function scrapeUrl(url: string, options?: ScraperOptions): Promise<ScrapedProduct> {
  const scraper = findScraper(url)
  if (!scraper) {
    throw new ScraperError('このURLに対応するスクレイパーが見つかりません', 'unknown', url)
  }
  return scraper.scrape(url, options as ScraperOptions)
}

export type { IScraper, ScrapedProduct, ScraperOptions }
export { ScraperError }
