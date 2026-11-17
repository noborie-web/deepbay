import * as cheerio from 'cheerio'
import type { Browser } from 'playwright-core'
import type { IScraper, ScrapedProduct, ScraperOptions } from './types'
import { ScraperError } from './types'
import { launchHeadlessBrowser } from './headless-browser'
import { mercariApiFetch } from './mercari-dpop'

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

// 単品ページのcheerio解析ロジック本体(クラスの`parse`メソッドとmercari.ts
// からのShops商品エンリッチメントの両方で共有する純粋関数)。
function parseShopProductHtml($: cheerio.CheerioAPI, url: string, siteKey: string): ScrapedProduct {
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

  // 実際のページで確認: 売り切れ商品はレンダリング後のHTMLで購入ボタンが
  // <button disabled data-testid="disabled-purchase-button">に置き換わる
  // (未ログイン状態でも表示され、在庫あり商品にはこのdata-testidは無い)。
  const availability: ScrapedProduct['availability'] = $('[data-testid="disabled-purchase-button"]').length > 0
    ? 'sold_out'
    : 'available'

  return {
    sourceUrl: url,
    sourceSite: siteKey,
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
    availability,
  }
}

// ---------------------------------------------------------------------------
// Shops商品の詳細取得(API)
//
// 本番で確認した不具合(2026-11-15): Shops商品の詳細はヘッドレスブラウザで
// しか取れないものとして実装していたが、Vercel上ではブラウザがほぼ必ず
// "browser.newPage: Target page, context or browser has been closed" で
// 落ちており、説明文が空のまま残った商品が76件たまっていた。
//
// 実データで確認(2026-11-15): Shopsの商品ページが読んでいるのは
//   GET https://api.mercari.jp/v1/marketplaces/shops/products/{id}?view=FULL
// で、通常のメルカリ検索と同じDPoP署名だけで200を返す。説明文・カテゴリ・
// 商品の状態・大サイズ画像・在庫・評価数まで含まれるため、ブラウザは不要。
// (商品ページのHTMLには説明文が無く、og:descriptionはSEO用の定型文なので
//  単純なfetch+cheerioでは代用できない)
// ---------------------------------------------------------------------------

const SHOPS_PRODUCT_API = 'https://api.mercari.jp/v1/marketplaces/shops/products'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function _productFromShopsApi(json: any): ScrapedProduct {
  const detail = json?.productDetail ?? {}
  const itemId: string | null = typeof json?.name === 'string' ? json.name : null
  const tags: string[] = Array.isArray(json?.productTags) ? json.productTags : []

  // categories は「深い階層→ルート」の順で返る(実データで確認)。
  const categories: any[] = Array.isArray(detail.categories) ? detail.categories : []
  const categoryNames = categories
    .map((c) => (typeof c?.displayName === 'string' ? c.displayName : ''))
    .filter(Boolean)

  const photos: string[] = Array.isArray(detail.photos)
    ? detail.photos.filter((p: unknown): p is string => typeof p === 'string')
    : []

  const price = json?.price != null ? parseInt(String(json.price), 10) : NaN
  const reviewCount = detail.shop?.shopStats?.reviewCount
  const ratingCount = reviewCount != null ? parseInt(String(reviewCount), 10) : NaN

  return {
    sourceUrl: `https://jp.mercari.com/shops/product/${itemId ?? ''}`,
    sourceSite: 'mercari_shops',
    sourceItemId: itemId,
    title: typeof json?.displayName === 'string' ? json.displayName : '',
    price: Number.isFinite(price) ? price : null,
    description: typeof detail.description === 'string' ? detail.description : '',
    images: photos,
    condition: typeof detail.condition?.displayName === 'string' ? detail.condition.displayName : null,
    category: categoryNames[0] ?? null,
    categoryPath: categoryNames.length > 0 ? [...categoryNames].reverse() : undefined,
    // 通常のメルカリと同じく、オークション形式の商品は抽出時に除外する
    // (2026-11-15に入れた除外を、Shops商品でも効かせる)
    ...(detail.auction != null ? { priceType: 'auction' as const } : {}),
    sellerRatingCount: Number.isFinite(ratingCount) ? ratingCount : null,
    shippingDays: typeof detail.shippingDuration?.minDays === 'number' ? detail.shippingDuration.minDays : null,
    sourceUpdatedAt: typeof json?.updateTime === 'string' ? json.updateTime : null,
    availability: tags.includes('sold_out') || tags.includes('out_of_stock') ? 'sold_out' : 'available',
    rawData: json ?? null,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Shops商品の詳細をAPIから取得する。ブラウザを使わないので速く、
 * サーバーレス環境でも落ちない。
 */
export async function fetchShopProductDetailByApi(
  itemId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ScrapedProduct> {
  const { timeoutMs = 15000, signal } = options
  const url = `${SHOPS_PRODUCT_API}/${encodeURIComponent(itemId)}?view=FULL&imageType=JPEG`
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await mercariApiFetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) {
    throw new ScraperError(`Shops API error: ${res.status}`, 'mercari_shops', url, res.status)
  }
  const json = await res.json()
  const product = _productFromShopsApi(json)
  // 説明文も画像も無い応答は、仕様変更で中身を拾えていない可能性が高い。
  // 黙って「空の成功」を返すと補完済みとして固定されてしまうため失敗にする。
  if (!product.description.trim() && product.images.length === 0) {
    throw new ScraperError('Shops APIの応答に説明文も画像も無い', 'mercari_shops', url)
  }
  return product
}

/**
 * 複数のShops商品の詳細をまとめて取得する。
 * APIで取れなかったぶんだけ、最後の手段としてヘッドレスブラウザで試す
 * (ブラウザは1件ごとに起動し直さず、数件ごとに使い回す)。
 */
export async function fetchShopProductDetails(
  itemIds: string[],
  options: {
    concurrency?: number
    timeoutMs?: number
    shouldStop?: () => boolean
    browserFallback?: boolean
    onFailure?: (itemId: string, error: string) => void
  } = {},
): Promise<Map<string, ScrapedProduct>> {
  // ブラウザでの再試行は既定で使わない。Vercel上ではChromiumがほぼ必ず
  // 落ちるうえ、起動だけで十数秒かかって他の処理の時間予算を食うため、
  // すでにブラウザを使えている経路(Shops専用の検索抽出)からだけ有効にする。
  const { concurrency = 4, timeoutMs = 15000, shouldStop, browserFallback = false, onFailure } = options
  const results = new Map<string, ScrapedProduct>()
  const failures: Array<{ itemId: string; error: string }> = []

  const queue = [...new Set(itemIds)]
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    while (next < queue.length) {
      if (shouldStop?.()) return
      const itemId = queue[next++]
      try {
        results.set(itemId, await fetchShopProductDetailByApi(itemId, { timeoutMs }))
      } catch (err) {
        failures.push({ itemId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }))

  if (failures.length > 0 && browserFallback && !shouldStop?.()) {
    // 1件ごとにブラウザを起動すると起動コスト(サーバーレスでは十数秒)が
    // 支配的になるため使い回す。ただし同じブラウザを使い続けると数件で
    // "disconnected" になる実績があるので、一定件数ごとに起動し直す。
    let browser: Browser | undefined
    let usedByBrowser = 0
    try {
      for (const failure of failures.slice(0, BROWSER_FALLBACK_MAX)) {
        if (shouldStop?.()) break
        if (!browser || usedByBrowser >= BROWSER_RELAUNCH_EVERY) {
          await browser?.close().catch(() => {})
          browser = await launchHeadlessBrowser()
          usedByBrowser = 0
        }
        usedByBrowser += 1
        try {
          const detail = await fetchShopProductDetail(browser, failure.itemId, { timeoutMs })
          if (detail && (detail.description.trim() || detail.images.length > 0)) {
            results.set(failure.itemId, detail)
            failure.error = ''
          }
        } catch (err) {
          failure.error = err instanceof Error ? err.message : String(err)
          // ブラウザごと落ちている可能性があるので次は起動し直す
          usedByBrowser = BROWSER_RELAUNCH_EVERY
        }
      }
    } catch (err) {
      console.error('[mercari shops] browser fallback unavailable:', err instanceof Error ? err.message : err)
    } finally {
      await browser?.close().catch(() => {})
    }
  }

  for (const failure of failures) {
    if (failure.error) onFailure?.(failure.itemId, failure.error)
  }
  return results
}

// ブラウザでの再試行はAPIが使えないときの保険なので、件数は絞る
const BROWSER_FALLBACK_MAX = 8
const BROWSER_RELAUNCH_EVERY = 5

// mercari.ts側(通常のメルカリ検索にShops商品が混在するケース)から
// 単品ページの詳細(description/category/condition)を補完するために使う。
// ブラウザのライフサイクル管理は呼び出し側の責務とする(1件ごとに
// 起動すると遅すぎるため、複数件をまとめて処理する側で使い回す前提)。
export async function fetchShopProductDetail(
  browser: Browser,
  itemId: string,
  options: { userAgent?: string; timeoutMs?: number } = {},
): Promise<ScrapedProduct | null> {
  const { userAgent = DEFAULT_UA, timeoutMs = 20000 } = options
  const url = `https://jp.mercari.com/shops/product/${itemId}`
  const page = await browser.newPage({ userAgent })
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForSelector('[data-testid="product-price"]', { timeout: timeoutMs }).catch(() => {})
    const html = await page.content()
    const $ = cheerio.load(html)
    return parseShopProductHtml($, url, 'mercari_shops')
  } finally {
    await page.close().catch(() => {})
  }
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
      browser = await launchHeadlessBrowser()
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
      browser = await launchHeadlessBrowser()
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

    const limited = allProducts.slice(0, effectiveLimit)
    return this.enrichSearchResults(limited, { userAgent, timeoutMs })
  }

  // 検索結果一覧はタイトル・価格・サムネイルのみのため、商品ごとに
  // 商品説明・カテゴリー・状態・全画像を補完する。
  //
  // 以前はここでも商品ページをヘッドレスブラウザで開いていたため非常に
  // 重く、補完対象を先頭の数十件に絞っていた(それ以降の商品は説明文が
  // 空のまま登録されていた)。APIから取れるようになったので全件補完する。
  private async enrichSearchResults(
    products: ScrapedProduct[],
    options: { userAgent: string; timeoutMs: number },
  ): Promise<ScrapedProduct[]> {
    const itemIds = products
      .map((p) => p.sourceItemId)
      .filter((id): id is string => Boolean(id))
    if (itemIds.length === 0) return products

    // この経路は検索結果の取得にすでにブラウザを使えているので、
    // APIで取れなかったぶんはブラウザで取り直す
    const detailByItemId = await fetchShopProductDetails(itemIds, {
      timeoutMs: options.timeoutMs,
      browserFallback: true,
    })

    return products.map((product) => {
      const detail = product.sourceItemId ? detailByItemId.get(product.sourceItemId) : undefined
      if (!detail) return product
      return {
        ...product,
        description: detail.description || product.description,
        category: detail.category ?? product.category,
        condition: detail.condition ?? product.condition,
        images: detail.images.length > 0 ? detail.images : product.images,
      }
    })
  }

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    return parseShopProductHtml($, url, this.siteKey)
  }
}
