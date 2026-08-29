import * as cheerio from 'cheerio'
import type { Browser } from 'playwright-core'
import type { IScraper, ScrapedProduct, ScraperOptions } from './types'
import { ScraperError } from './types'

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * メルカリShopsの商品ページは価格・状態・カテゴリがクライアントサイド
 * レンダリングで、初期HTMLには含まれない(タイトル・説明・メイン画像1枚は
 * og:タグ経由で取得できるが、価格等は取得できない)。そのためこのスクレイパー
 * のみ、他サイトのfetch+cheerioパターンではなくヘッドレスブラウザで
 * レンダリングしてから読み取る。
 *
 * サーバーレス環境(Vercel)では @sparticuz/chromium の軽量バイナリを、
 * ローカル開発では通常の playwright パッケージが持つChromiumを使う。
 */
async function launchBrowser(): Promise<Browser> {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

  if (isServerless) {
    const [{ chromium }, sparticuzChromiumModule] = await Promise.all([
      import('playwright-core'),
      import('@sparticuz/chromium'),
    ])
    const sparticuzChromium = sparticuzChromiumModule.default
    return chromium.launch({
      args: sparticuzChromium.args,
      executablePath: await sparticuzChromium.executablePath(),
      headless: true,
    })
  }

  const { chromium } = await import('playwright')
  return chromium.launch({ headless: true })
}

export class MercariShopsScraper implements IScraper {
  name = 'メルカリShops'
  siteKey = 'mercari_shops'
  urlPattern = /jp\.mercari\.com\/shops\/product\/[a-zA-Z0-9]+/

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    const { userAgent = DEFAULT_UA, timeoutMs = 20000 } = options

    let browser: Browser | undefined
    try {
      browser = await launchBrowser()
      const page = await browser.newPage({ userAgent })
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      // 価格はクライアントサイドレンダリングのため、表示されるまで待つ。
      // 商品が存在しない/削除済みの場合はタイムアウトし、取得できた範囲で解析する。
      await page.waitForSelector('[data-testid="product-price"]', { timeout: timeoutMs }).catch(() => {})

      const html = await page.content()
      const $ = cheerio.load(html)
      return [this.parse($, url)]
    } catch (err) {
      if (err instanceof ScraperError) throw err
      throw new ScraperError(
        err instanceof Error ? err.message : 'Unknown error',
        this.siteKey,
        url,
      )
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/\/shops\/product\/([a-zA-Z0-9]+)/)?.[1] ?? null

    const title = $('[data-testid="display-name"]').first().text().trim()
      || $('meta[property="og:title"]').attr('content')?.replace(/\s*-\s*メルカリ\s*$/, '').trim()
      || ''

    const priceText = $('[data-testid="product-price"]').first().text().trim()
    const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null

    const description = $('[data-testid="description"]').first().text().trim()
      || $('meta[property="og:description"]').attr('content')?.trim()
      || ''

    const condition = $('[data-testid="商品の状態"]').first().text().trim() || null

    // パンくずの各階層はリンク+テキストで二重に取得されることがあるため重複除去し、
    // 最も詳細な(末尾の)階層をカテゴリとする。
    const categoryParts = Array.from(new Set(
      $('[data-testid="product-detail-category"]').find('a, span')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean),
    ))
    const category = categoryParts.length > 0 ? categoryParts[categoryParts.length - 1] : null

    const images = Array.from({ length: 12 }, (_, i) => {
      const el = $(`[data-testid="image-${i}"]`).first()
      if (el.length === 0) return null
      const img = el.is('img') ? el : el.find('img').first()
      return img.attr('src') ?? null
    }).filter((src): src is string => Boolean(src))

    const fallbackImage = $('meta[property="og:image"]').attr('content')

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title,
      price,
      description,
      images: images.length > 0 ? images : (fallbackImage ? [fallbackImage] : []),
      condition,
      category,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    }
  }
}
