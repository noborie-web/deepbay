import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

// Yahoo!フリマ(旧PayPayフリマ)のスクレイパー。
//
// ユーザー要望・実データで確認した経緯: ヤフオクの検索結果にYahoo!フリマの
// 出品が混ざって表示される利用者がおり(定額244件のうち大半がフリマ出品)、
// ヤフオク取り込み(オークション出品のみ対象)では取り込めなかった。
// Yahoo!フリマは個人出品の定額・全品送料無料・匿名配送で、eBay転売の仕入先
// として相性が良いため、検索URLからの一括取り込みと商品ページの取得
// (在庫管理の売り切れ・価格チェック)に対応する。
//
// 実データで確認したURL/構造(2026-09-21):
//  - 検索: https://paypayfleamarket.yahoo.co.jp/search/{キーワード}?open=1
//          &minPrice=5000&maxPrice=50000&conditions=NEW,USED20,...&page=2
//          (1ページ100件、サーバー側でレンダリング済み。商品カードは
//           a[href^="/item/"] で data-cl-params に price / sellerid を含む。
//           売り切れは img[alt="sold"] のバッジで判別)
//  - 商品: https://paypayfleamarket.yahoo.co.jp/item/{z...}
//          (application/ld+json の Product に name/image/description/offers、
//           offers.availability が InStock / OutOfStock。
//           「商品の情報」表(th/td)に 商品の状態・発送までの日数・カテゴリ、
//           出品者は a[href^="/user/"] と評価数「（56）」)

const SEARCH_URL_PATTERN = /paypayfleamarket\.yahoo\.co\.jp\/search\//
const ITEM_URL_PATTERN = /paypayfleamarket\.yahoo\.co\.jp\/item\/([a-z0-9]+)/
const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const PAGE_SIZE = 100
const DETAIL_CONCURRENCY = 8
const ORIGIN = 'https://paypayfleamarket.yahoo.co.jp'

// 検索結果のサムネイルはリサイズ指定付き(w=298&h=298)なので、クエリを外して元画像にする
function originalImageUrl(src: string): string {
  return src.split('?')[0]
}

function parseShippingDays(text: string | null | undefined): number | null {
  if (!text) return null
  const m = text.match(/(\d+)\s*[~〜～]?\s*\d*\s*日/)
  return m ? parseInt(m[1], 10) : null
}

// 出品日時: 「2026年9月21日 12:22」(JST)
function parseListedAt(text: string | null | undefined): string | null {
  const m = text?.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:00+09:00`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractProductLdJson($: cheerio.CheerioAPI): Record<string, any> | null {
  let found: Record<string, unknown> | null = null
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return
    try {
      const parsed = JSON.parse($(el).text())
      const candidates = Array.isArray(parsed) ? parsed : [parsed]
      for (const c of candidates) {
        if (c && typeof c === 'object' && c['@type'] === 'Product') { found = c; break }
      }
    } catch {
      // 壊れたJSONは無視
    }
  })
  return found
}

// ---------------------------------------------------------------------------
// ヤフオク検索条件 → Yahoo!フリマ検索URL の変換
//
// 実データで確認(2026-09-21): Yahoo!フリマの検索は minPrice/maxPrice、
// conditions(NEW,USED10,USED20,USED40,USED60,USED80)、categoryIds(フリマの
// カテゴリID)、open=1(販売中)で絞り込める。カテゴリIDはヤフオクと体系が
// 異なるため、ヤフオク検索ページのカテゴリ階層(例: おもちゃ、ゲーム >
// ゲーム > テレビゲーム > ファミコン > タイトル)を、フリマのカテゴリAPI
// (/api/v1/categories/{id}/children)を名前で辿って対応付ける
// (例: ゲーム、おもちゃ > テレビゲーム > 旧機種 > ファミコン > ソフト)。
// ---------------------------------------------------------------------------

export interface YahooFleaCategory { id: number; name: string }
export type YahooFleaCategoryFetcher = (parentId: number) => Promise<YahooFleaCategory[]>

const CATEGORY_API_ROOT = 1
// ヤフオク側の階層名のうち、フリマでは別名になっているもの
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  'タイトル': ['ソフト'],
  'ソフト': ['タイトル'],
}
// 検索キーワードに補う価値のない汎用的な階層名
const GENERIC_CATEGORY_NAMES = new Set(['すべてのカテゴリ', 'タイトル', 'ソフト', '本体', '周辺機器', 'その他', 'アクセサリー'])
const MAX_CATEGORY_API_CALLS = 40

function categoryTokens(name: string): string[] {
  return name.split(/[、,・/／\s]+/).map(t => t.trim()).filter(Boolean).sort()
}

function categoryNameMatches(fleaName: string, auctionName: string): boolean {
  if (fleaName === auctionName) return true
  const a = categoryTokens(fleaName)
  const b = categoryTokens(auctionName)
  if (a.length > 0 && a.length === b.length && a.every((t, i) => t === b[i])) return true
  return (CATEGORY_SYNONYMS[auctionName] ?? []).includes(fleaName)
}

export async function fetchYahooFleaCategoryChildren(parentId: number, userAgent = DEFAULT_UA): Promise<YahooFleaCategory[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${ORIGIN}/api/v1/categories/${parentId}/children`, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (!Array.isArray(json)) return []
    return json
      .filter((c): c is { id: number; name: string } => c && typeof c.id === 'number' && typeof c.name === 'string')
      .map(c => ({ id: c.id, name: c.name }))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * ヤフオクのカテゴリ階層名を、Yahoo!フリマのカテゴリIDに対応付ける。
 * 各階層名を、現在のフリマカテゴリ配下(子・孫まで)から名前で探し、見つかれば
 * そこへ降りる。見つからない階層(ヤフオク独自の中間階層)は読み飛ばす。
 * 対応付けできた最も深いカテゴリのIDを返す(1つも対応しなければ null)。
 */
export async function resolveYahooFleaCategoryId(
  auctionCategoryPath: string[],
  fetchChildren: YahooFleaCategoryFetcher = (id) => fetchYahooFleaCategoryChildren(id),
): Promise<number | null> {
  const names = auctionCategoryPath.filter(n => n && n !== 'すべてのカテゴリ')
  if (names.length === 0) return null
  const cache = new Map<number, YahooFleaCategory[]>()
  let calls = 0
  const children = async (id: number): Promise<YahooFleaCategory[]> => {
    const cached = cache.get(id)
    if (cached) return cached
    if (calls >= MAX_CATEGORY_API_CALLS) return []
    calls += 1
    const result = await fetchChildren(id).catch(() => [] as YahooFleaCategory[])
    cache.set(id, result)
    return result
  }

  let current = CATEGORY_API_ROOT
  let resolved: number | null = null
  for (const name of names) {
    // 子 → 孫 の順に探す(ヤフオク側に無い中間階層がフリマ側にあっても辿れる)
    const kids = await children(current)
    let found = kids.find(k => categoryNameMatches(k.name, name)) ?? null
    if (!found) {
      for (const kid of kids) {
        const grandkids = await children(kid.id)
        const hit = grandkids.find(g => categoryNameMatches(g.name, name))
        if (hit) { found = hit; break }
      }
    }
    if (found) {
      current = found.id
      resolved = found.id
    }
  }
  return resolved
}

/**
 * ヤフオク検索URL(+検索ページから読み取ったカテゴリ階層)から、同じ条件の
 * Yahoo!フリマ検索URLを組み立てる。
 */
export async function buildYahooFleaSearchUrlFromAuction(
  auctionSearchUrl: string,
  auctionCategoryPath: string[],
  fetchChildren?: YahooFleaCategoryFetcher,
): Promise<string | null> {
  const src = new URL(auctionSearchUrl)
  const keyword = (src.searchParams.get('p') ?? src.searchParams.get('va') ?? '').trim()
  if (!keyword) return null

  const categoryId = await resolveYahooFleaCategoryId(auctionCategoryPath, fetchChildren)
  // カテゴリを対応付けできなかった場合は、最も具体的な階層名をキーワードに補う
  let searchKeyword = keyword
  if (categoryId === null) {
    const specific = [...auctionCategoryPath].reverse().find(n => n && !GENERIC_CATEGORY_NAMES.has(n))
    if (specific && !keyword.includes(specific)) searchKeyword = `${keyword} ${specific}`
  }

  const dest = new URL(`${ORIGIN}/search/${encodeURIComponent(searchKeyword)}`)
  dest.searchParams.set('open', '1')
  const min = src.searchParams.get('min')
  const max = src.searchParams.get('max')
  if (min && /^\d+$/.test(min)) dest.searchParams.set('minPrice', min)
  if (max && /^\d+$/.test(max)) dest.searchParams.set('maxPrice', max)
  // ヤフオクの istatus: 1=未使用, 2=中古(全グレード)
  const istatus = (src.searchParams.get('istatus') ?? '').split(',').map(v => v.trim()).filter(Boolean)
  if (istatus.length > 0) {
    const conditions: string[] = []
    if (istatus.includes('1')) conditions.push('NEW')
    if (istatus.includes('2')) conditions.push('USED10', 'USED20', 'USED40', 'USED60', 'USED80')
    if (conditions.length > 0) dest.searchParams.set('conditions', conditions.join(','))
  }
  if (categoryId !== null) dest.searchParams.set('categoryIds', String(categoryId))
  return dest.toString()
}

export class YahooFleaScraper extends BaseScraper {
  name = 'Yahoo!フリマ'
  siteKey = 'yahoo_flea'
  urlPattern = ITEM_URL_PATTERN

  matches(url: string): boolean {
    return ITEM_URL_PATTERN.test(url) || SEARCH_URL_PATTERN.test(url)
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    if (SEARCH_URL_PATTERN.test(url)) return this.scrapeSearch(url, options)
    return super.scrape(url, options)
  }

  private async fetchHtml(url: string, userAgent: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, 'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3' },
        signal: controller.signal,
      })
      if (!res.ok) throw new ScraperError(`HTTP ${res.status}: ${res.statusText}`, this.siteKey, url)
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }

  // 検索結果ページから商品カードを取り出す(公開メソッドにしてテスト可能にする)
  parseSearchPage($: cheerio.CheerioAPI): ScrapedProduct[] {
    const products: ScrapedProduct[] = []
    $('a[href^="/item/"]').each((_, el) => {
      const $el = $(el)
      const href = $el.attr('href') ?? ''
      const itemId = href.match(/^\/item\/([a-z0-9]+)/)?.[1]
      if (!itemId) return
      const params = $el.attr('data-cl-params') ?? ''
      // 商品カード以外のリンク(おすすめ等)は data-cl-params の _cl_link:itm で見分ける
      if (params && !/_cl_link:itm;/.test(params)) return
      const $img = $el.find('img').first()
      const title = ($img.attr('alt') ?? '').trim()
      if (!title) return
      const priceFromParams = params.match(/;price:(\d+);/)?.[1]
      const priceText = $el.find('p').filter((__, p) => /円/.test($(p).text())).first().text()
      const price = priceFromParams
        ? parseInt(priceFromParams, 10)
        : (parseInt(priceText.replace(/[^\d]/g, ''), 10) || null)
      const sellerId = params.match(/;sellerid:([A-Za-z0-9_-]+);/)?.[1]
      const sold = $el.find('img[alt="sold"]').length > 0
      const imgSrc = $img.attr('src') ?? ''
      // 実データで確認: Yahoo!フリマの検索結果にはヤフオクの定額出品も混ざる
      // (IDが z 以外で始まる)。それらはヤフオクの商品として扱い、商品ページ・
      // 在庫チェックはヤフオク側で行う。
      const isAuctionItem = !itemId.startsWith('z')
      products.push({
        sourceUrl: isAuctionItem ? `https://auctions.yahoo.co.jp/jp/auction/${itemId}` : `${ORIGIN}/item/${itemId}`,
        sourceSite: isAuctionItem ? 'yahoo_auction' : this.siteKey,
        sourceItemId: itemId,
        title,
        price: Number.isFinite(price as number) ? price : null,
        description: '',
        images: imgSrc ? [originalImageUrl(imgSrc)] : [],
        condition: null,
        category: null,
        sellerRatingCount: null,
        shippingDays: null,
        sourceUpdatedAt: null,
        availability: sold ? 'sold_out' : 'available',
        sellerUrl: sellerId ? `${ORIGIN}/user/${sellerId}` : null,
      })
    })
    return products
  }

  private async scrapeSearch(url: string, options: ScraperOptions): Promise<ScrapedProduct[]> {
    const { userAgent = DEFAULT_UA, timeoutMs = 15000, limit = 600, onPage } = options
    const baseUrl = new URL(url)
    // 販売中のみを対象にする(売り切れは抽出に含めない)。URLに指定が無ければ付与する。
    if (!baseUrl.searchParams.has('open') && !baseUrl.searchParams.has('sold')) {
      baseUrl.searchParams.set('open', '1')
    }

    const allProducts: ScrapedProduct[] = []
    const seenIds = new Set<string>()
    const maxPages = Math.ceil(limit / PAGE_SIZE) + 2

    for (let page = 1; page <= maxPages && allProducts.length < limit; page++) {
      baseUrl.searchParams.set('page', String(page))
      let html: string
      try {
        html = await this.fetchHtml(baseUrl.toString(), userAgent, timeoutMs)
      } catch (err) {
        if (page === 1) {
          if (err instanceof ScraperError) throw err
          throw new ScraperError(err instanceof Error ? err.message : 'Unknown error', this.siteKey, url)
        }
        break
      }

      const pageProducts = this.parseSearchPage(cheerio.load(html))
      // そのページに商品が無ければ終了(件数がページサイズ未満でも次ページを見る)
      if (pageProducts.length === 0) break
      let added = 0
      for (const p of pageProducts) {
        if (seenIds.has(p.sourceItemId!)) continue
        seenIds.add(p.sourceItemId!)
        allProducts.push(p)
        added += 1
      }
      // 最終ページを超えると同じ内容が返ることがあるため、新規0件でも終了する
      if (added === 0) break
      onPage?.(allProducts.length, limit)
      if (pageProducts.length < PAGE_SIZE) break
    }

    if (allProducts.length === 0) {
      throw new ScraperError('検索結果が0件です', this.siteKey, url)
    }

    return this.enrichDetails(allProducts.slice(0, limit), options)
  }

  // 検索結果には説明文・状態・発送日数・評価数が無いため、商品ページを取得して補完する
  private async enrichDetails(products: ScrapedProduct[], options: ScraperOptions): Promise<ScrapedProduct[]> {
    if (options.skipDetailEnrichment) return products
    const { userAgent = DEFAULT_UA, timeoutMs = 15000, onPage } = options
    const results: ScrapedProduct[] = []
    for (let index = 0; index < products.length; index += DETAIL_CONCURRENCY) {
      const chunk = products.slice(index, index + DETAIL_CONCURRENCY)
      const enriched = await Promise.all(chunk.map(async (product) => {
        try {
          const html = await this.fetchHtml(product.sourceUrl, userAgent, timeoutMs)
          const detail = product.sourceSite === 'yahoo_auction'
            ? new (await import('./yahoo_auction')).YahooAuctionScraper().parse(cheerio.load(html), product.sourceUrl)
            : this.parse(cheerio.load(html), product.sourceUrl)
          return {
            ...product,
            title: detail.title || product.title,
            price: detail.price ?? product.price,
            description: detail.description || product.description,
            images: detail.images.length > 0 ? detail.images : product.images,
            condition: detail.condition ?? product.condition,
            category: detail.category ?? product.category,
            sellerRatingCount: detail.sellerRatingCount ?? product.sellerRatingCount,
            shippingDays: detail.shippingDays ?? product.shippingDays,
            sourceUpdatedAt: detail.sourceUpdatedAt ?? product.sourceUpdatedAt,
            availability: detail.availability ?? product.availability,
            sellerUrl: detail.sellerUrl ?? product.sellerUrl,
            rawData: detail.rawData ?? null,
          }
        } catch (err) {
          console.error('[yahoo flea enrich] failed for', product.sourceItemId, err instanceof Error ? err.message : err)
          return product
        }
      }))
      results.push(...enriched)
      onPage?.(results.length, products.length)
    }
    return results
  }

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(ITEM_URL_PATTERN)?.[1] ?? null
    const ld = extractProductLdJson($)

    const title = (typeof ld?.name === 'string' && ld.name.trim()) || $('h1').first().text().trim()
    const offers = ld?.offers && typeof ld.offers === 'object' ? ld.offers : null
    const ldPrice = typeof offers?.price === 'number' ? offers.price : parseFloat(String(offers?.price ?? ''))
    const price = Number.isFinite(ldPrice) && ldPrice > 0 ? ldPrice : null
    const description = typeof ld?.description === 'string' ? ld.description.trim() : ''
    const images = Array.isArray(ld?.image)
      ? ld.image.filter((u: unknown): u is string => typeof u === 'string' && u.length > 0)
      : (typeof ld?.image === 'string' ? [ld.image] : [])

    // 「商品の情報」表
    const info = new Map<string, string>()
    $('th').each((_, th) => {
      const key = $(th).text().trim()
      const value = $(th).next('td').text().trim()
      if (key && value) info.set(key, value)
    })
    const condition = info.get('商品の状態') ?? null
    const shippingDays = parseShippingDays(info.get('発送までの日数'))
    const categoryLinks = $('a[href^="/category/"]').map((_, a) => $(a).text().trim()).get().filter(Boolean)
    const category = categoryLinks.length > 0 ? categoryLinks[categoryLinks.length - 1] : null

    const sellerHref = $('a[href^="/user/"]').first().attr('href') ?? null
    const sellerUrl = sellerHref ? `${ORIGIN}${sellerHref}` : null
    const ratingText = $('a[href^="/user/"]').first().text()
    const ratingMatch = ratingText.match(/[（(]\s*(\d+)\s*[）)]/)
    const sellerRatingCount = ratingMatch ? parseInt(ratingMatch[1], 10) : null

    const listedAtText = $('*').filter((_, el) => /出品日時/.test($(el).text()) && $(el).children().length <= 2).last().text()
    const sourceUpdatedAt = parseListedAt(listedAtText)

    const availabilityRaw = typeof offers?.availability === 'string' ? offers.availability : ''
    const soldByText = /で売れました/.test($('body').text())
    const availability: ScrapedProduct['availability'] = /OutOfStock|SoldOut/i.test(availabilityRaw) || soldByText
      ? 'sold_out'
      : (/InStock/i.test(availabilityRaw) ? 'available' : 'unknown')

    if (!title) {
      throw new ScraperError('商品情報を取得できませんでした', this.siteKey, url)
    }

    return {
      sourceUrl: itemId ? `${ORIGIN}/item/${itemId}` : url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title,
      price,
      description,
      images,
      condition,
      category,
      sellerRatingCount,
      shippingDays,
      sourceUpdatedAt,
      availability,
      sellerUrl,
      rawData: ld ? { ldJson: ld, info: Object.fromEntries(info) } : null,
    }
  }
}
