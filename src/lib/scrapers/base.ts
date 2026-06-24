import * as cheerio from 'cheerio'
import type { IScraper, ScrapedProduct, ScraperOptions } from './types'
import { ScraperError } from './types'

const DEFAULT_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
}

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export abstract class BaseScraper implements IScraper {
  abstract name: string
  abstract siteKey: string
  abstract urlPattern: RegExp

  abstract parse($: cheerio.CheerioAPI, url: string): ScrapedProduct

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct> {
    const { userAgent = DEFAULT_UA, timeoutMs = 15000 } = options

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, 'User-Agent': userAgent },
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new ScraperError(
          `HTTP ${res.status}: ${res.statusText}`,
          this.siteKey,
          url,
        )
      }

      const html = await res.text()
      const $ = cheerio.load(html)
      return this.parse($, url)
    } catch (err) {
      if (err instanceof ScraperError) throw err
      throw new ScraperError(
        err instanceof Error ? err.message : 'Unknown error',
        this.siteKey,
        url,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
