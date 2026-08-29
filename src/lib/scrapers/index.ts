import type { IScraper, ScrapedProduct, ScraperOptions } from './types'
import { ScraperError } from './types'
import { MercariScraper } from './mercari'
import { YahooAuctionScraper } from './yahoo_auction'
import { RakumaScraper } from './rakuma'
import { SnkrDunkScraper } from './snkrdunk'
import { DigimartScraper } from './digimart'
import { YahooShoppingScraper } from './yahoo_shopping'
import { VectorParkScraper } from './vector_park'
import { TrefacScraper } from './trefac'
import { MercariShopsScraper } from './mercari_shops'

const SCRAPERS: IScraper[] = [
  new MercariScraper() as unknown as IScraper,
  new YahooAuctionScraper(),
  new RakumaScraper(),
  new SnkrDunkScraper() as unknown as IScraper,
  new DigimartScraper(),
  new YahooShoppingScraper(),
  new VectorParkScraper(),
  new TrefacScraper(),
  new MercariShopsScraper(),
]

export function findScraper(url: string): IScraper | null {
  return SCRAPERS.find((s) => (s.matches ? s.matches(url) : s.urlPattern.test(url))) ?? null
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
