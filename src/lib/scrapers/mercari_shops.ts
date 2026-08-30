import * as cheerio from 'cheerio'
import type { Browser } from 'playwright-core'
import type { IScraper, ScrapedProduct, ScraperOptions } from './types'
import { ScraperError } from './types'

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const SEARCH_URL_PATTERN = /jp\.mercari\.com\/search\?.*\bitem_types=beyond\b/
// 検索一括抽出はPlaywrightで1ページ(6件程度)ずつ実際にレンダリングする
// 必要があり、fetch+cheerioの他サイトと比べて1件あたりのコストが桁違いに
// 高い。limitにそのまま600を指定すると100ページ分のレンダリングが必要に
// なり、Vercelの実行時間上限(5分)を超えるおそれがあるため、要求された
// limitとは無関係にこの絶対上限を設ける。
const MAX_SEARCH_ITEMS = 150

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
// 検索結果サムネイルは"/-/small/plain/{id}.jpg@webp"形式(小サイズ)。
// 単品ページのメイン画像と同じ"/-/large/plain/{id}.jpg@jpg"形式に書き換えて
// 大サイズ(1000x1000)を取得する(実データで確認済み)。
function upsizeImage(src: string): string {
  return src.replace('/-/small/plain/', '/-/large/plain/').replace(/@webp$/, '@jpg')
}

// 検索結果ページ1ページ分のHTMLから商品を抽出する純粋関数。
// Playwrightのブラウザ操作を伴わないため、静的HTMLフィクスチャで
// ユニットテスト可能(下部の_extractSearchItemsとしてテスト用に再エクスポート)。
function extractSearchItems($: cheerio.CheerioAPI, seenIds: Set<string>, siteKey: string): ScrapedProduct[] {
  const pageProducts: ScrapedProduct[] = []
  $('a[data-testid="thumbnail-link"]').each((_, el) => {
    const $el = $(el)
    const href = $el.attr('href') ?? ''
    const itemId = href.match(/\/shops\/product\/([a-zA-Z0-9]+)/)?.[1] ?? ''
    if (!itemId || seenIds.has(itemId)) return
    seenIds.add(itemId)

    const img = $el.find('img').first()
    // img altには"...のサムネイル"というアクセシビリティ用の接尾辞が
    // 付与されているため取り除く。
    const title = img.attr('alt')?.replace(/のサムネイル$/, '').trim() ?? ''
    const priceText = $el.find('.merPrice, [class*="priceContainer"]').first().text().trim()
    const price = priceText ? parseInt(priceText.replace(/[^0-9]/g, ''), 10) || null : null
    const imgSrc = img.attr('src') ?? ''

    pageProducts.push({
      sourceUrl: `https://jp.mercari.com/shops/product/${itemId}`,
      sourceSite: siteKey,
      sourceItemId: itemId,
      title,
      price,
      description: '',
      images: imgSrc ? [upsizeImage(imgSrc)] : [],
      condition: null,
      category: null,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    })
  })
  return pageProducts
}

export function _extractSearchItems($: cheerio.CheerioAPI, seenIds: Set<string>, siteKey = 'mercari_shops'): ScrapedProduct[] {
  return extractSearchItems($, seenIds, siteKey)
}

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

  matches(url: string): boolean {
    return this.urlPattern.test(url) || SEARCH_URL_PATTERN.test(url)
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    if (SEARCH_URL_PATTERN.test(url)) {
      return this.scrapeSearch(url, options)
    }

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

  private async scrapeSearch(url: string, options: ScraperOptions): Promise<ScrapedProduct[]> {
    const { userAgent = DEFAULT_UA, timeoutMs = 20000, limit = 600, onPage } = options
    const effectiveLimit = Math.min(limit, MAX_SEARCH_ITEMS)

    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()

    let browser: Browser | undefined
    try {
      browser = await launchBrowser()
      const page = await browser.newPage({ userAgent })

      let pageUrl = url
      let guard = 0
      const maxIterations = Math.ceil(effectiveLimit / 3) + 10 // 安全上限(1ページの実件数は変動しうるため余裕を持たせる)

      while (allProducts.length < effectiveLimit && guard < maxIterations) {
        guard += 1
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        await page.waitForSelector('a[data-testid="thumbnail-link"]', { timeout: timeoutMs }).catch(() => {})

        const html = await page.content()
        const $ = cheerio.load(html)

        const pageProducts = extractSearchItems($, seenIds, this.siteKey)

        // 「そのページの結果が0件」以外を終了条件にしてはいけない
        // (メルカリ検索抽出で見つかった不具合と同じ罠)。
        if (pageProducts.length === 0) break

        allProducts.push(...pageProducts)
        onPage?.(allProducts.length, effectiveLimit)

        const nextHref = await page
          .locator('a', { hasText: '次へ' })
          .first()
          .getAttribute('href')
          .catch(() => null)
        if (!nextHref) break
        pageUrl = new URL(nextHref, 'https://jp.mercari.com').toString()
      }
    } catch (err) {
      if (allProducts.length === 0) {
        if (err instanceof ScraperError) throw err
        throw new ScraperError(err instanceof Error ? err.message : 'Unknown error', this.siteKey, url)
      }
      // 途中まで取得できていれば、それまでの結果を返す(暴走防止優先)。
    } finally {
      await browser?.close().catch(() => {})
    }

    if (allProducts.length === 0) {
      throw new ScraperError('検索結果が0件です', this.siteKey, url)
    }

    return allProducts.slice(0, effectiveLimit)
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
