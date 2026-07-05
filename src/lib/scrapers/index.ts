import type { IScraper, ScrapedProduct, ScraperOptions } from './types'
import { ScraperError } from './types'
import { MercariScraper } from './mercari'
import { YahooAuctionScraper } from './yahoo_auction'
import { RakumaScraper } from './rakuma'
import { SnkrDunkScraper } from './snkrdunk'

const SCRAPERS: IScraper[] = [
  new MercariScraper() as unknown as IScraper,
  new YahooAuctionScraper(),
  new RakumaScraper(),
  new SnkrDunkScraper() as unknown as IScraper,
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

export async function scrapeUrl(url: string, options?: ScraperOptions): Promise<ScrapedProduct[]> {
  const scraper = findScraper(url)
  if (!scraper) {
    throw new ScraperError('このURLに対応するスクレイパーが見つかりません', 'unknown', url)
  }
  return scraper.scrape(url, options)
}

export type { IScraper, ScrapedProduct, ScraperOptions }
export { ScraperError }
