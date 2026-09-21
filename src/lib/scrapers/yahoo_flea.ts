import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'
import { fetchWithRetry, mapThrottled, RateLimitedError } from './throttled-fetch'

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
// 実データで計測(2026-09-21): Yahoo!フリマの商品ページは 1つのIPから約15件
// 取得すると429になり、約15分間ブロックされる(UAを変えても解除されない)。
// 制限に従い、1回の抽出/補完で取得する商品ページは FLEA_DETAIL_PER_RUN 件に
// 抑え、429が出た時点でそれ以上は取得しない(残りは抽出完了後に
// /api/extractions/[id]/enrich-details が15分おきに補完する)。
// 状態・評価数・出品日時・カテゴリは検索API(/api/v1/search)から全件取れるため、
// 商品ページでしか取れないのは説明文と2枚目以降の画像だけ。
export const FLEA_DETAIL_PER_RUN = 12
export const FLEA_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const DETAIL_INTERVAL_MS = 1000
const DETAIL_RETRIES = 0
const DETAIL_TIME_BUDGET_MS = 40_000
const SEARCH_API_PAGE_SIZE = 100
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

// ---------------------------------------------------------------------------
// 検索API(/api/v1/search)
//
// 実データで確認(2026-09-21): 検索ページが内部で呼ぶJSON API。パラメータは
// results(最大100)/offset/itemStatus(open|sold)/query/minPrice/maxPrice/
// itemConditions(NEW,USED10,...)/genreCategoryIds(表示カテゴリID)。
// 1件あたり id/title/price/thumbnailImageUrl/imageCount/category/brand/
// seller.numRating/condition(new|used10..used80)/openTime/itemStatus/hashtag。
// 商品ページと違い100件まとめて取れるため、状態・評価数・出品日時はこれで補完する。
// ---------------------------------------------------------------------------

const CONDITION_LABELS: Record<string, string> = {
  new: '未使用',
  used10: '未使用に近い',
  used20: '目立った傷や汚れなし',
  used40: 'やや傷や汚れあり',
  used60: '傷や汚れあり',
  used80: '全体的に状態が悪い',
}

export interface YahooFleaSearchApiItem {
  id: string
  title: string
  price: number
  thumbnailImageUrl?: string
  imageCount?: number
  category?: { id: number; name: string; path?: Array<{ id: number; name: string }> }
  brand?: { id: number; name: string } | null
  seller?: { id: string; numRating?: number; goodRatio?: number }
  sellerId?: string
  condition?: string
  openTime?: string
  itemStatus?: string
  hashtag?: string[]
}

export function buildYahooFleaSearchApiUrl(searchUrl: string, offset: number, results = SEARCH_API_PAGE_SIZE): string {
  const src = new URL(searchUrl)
  const keyword = decodeURIComponent(src.pathname.replace(/^\/search\//, '')).trim()
  const api = new URL(`${ORIGIN}/api/v1/search`)
  api.searchParams.set('results', String(results))
  api.searchParams.set('offset', String(offset))
  api.searchParams.set('itemStatus', src.searchParams.get('sold') === '1' ? 'sold' : 'open')
  if (keyword) api.searchParams.set('query', keyword)
  for (const key of ['minPrice', 'maxPrice', 'brandIds'] as const) {
    const value = src.searchParams.get(key)
    if (value) api.searchParams.set(key, value)
  }
  const conditions = src.searchParams.get('conditions')
  if (conditions) api.searchParams.set('itemConditions', conditions)
  // 検索ページのcategoryIdsは階層のID列(例: 2511,2161,16899,16904,16908)。APIは末尾のIDだけを使う
  const categoryIds = src.searchParams.get('categoryIds')
  if (categoryIds) {
    const leaf = categoryIds.split(',').map(v => v.trim()).filter(Boolean).pop()
    if (leaf) api.searchParams.set('genreCategoryIds', leaf)
  }
  return api.toString()
}

export function searchApiItemToProduct(item: YahooFleaSearchApiItem, siteKey: string): ScrapedProduct | null {
  const itemId = typeof item.id === 'string' ? item.id : ''
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  if (!itemId || !title) return null
  const isAuctionItem = !itemId.startsWith('z')
  const sellerId = item.seller?.id ?? item.sellerId ?? null
  const numRating = typeof item.seller?.numRating === 'number' ? item.seller.numRating : null
  const openTime = item.openTime ? new Date(item.openTime) : null
  return {
    sourceUrl: isAuctionItem ? `https://auctions.yahoo.co.jp/jp/auction/${itemId}` : `${ORIGIN}/item/${itemId}`,
    sourceSite: isAuctionItem ? 'yahoo_auction' : siteKey,
    sourceItemId: itemId,
    title,
    price: typeof item.price === 'number' && item.price > 0 ? item.price : null,
    description: '',
    images: item.thumbnailImageUrl ? [originalImageUrl(item.thumbnailImageUrl)] : [],
    condition: item.condition ? (CONDITION_LABELS[item.condition] ?? item.condition) : null,
    category: item.category?.name ?? null,
    sellerRatingCount: numRating,
    shippingDays: null,
    sourceUpdatedAt: openTime && !Number.isNaN(openTime.getTime()) ? openTime.toISOString() : null,
    availability: item.itemStatus === 'SOLD' ? 'sold_out' : 'available',
    sellerUrl: sellerId ? (isAuctionItem ? `https://auctions.yahoo.co.jp/seller/${sellerId}` : `${ORIGIN}/user/${sellerId}`) : null,
    rawData: {
      searchApi: item,
      brand: item.brand?.name ?? null,
      hashtags: item.hashtag ?? [],
      imageCount: item.imageCount ?? null,
      categoryPath: item.category?.path?.map(c => c.name) ?? [],
    },
  }
}

// 商品ページから取れた詳細で検索結果の情報を補う(検索結果にしか無い情報は残す)
export function mergeDetail(product: ScrapedProduct, detail: ScrapedProduct): ScrapedProduct {
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
    rawData: { ...(product.rawData ?? {}), ...(detail.rawData ?? {}) },
  }
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
    const { limit = 600, onPage } = options
    let products: ScrapedProduct[]
    try {
      products = await this.scrapeSearchApi(url, options)
    } catch (err) {
      // APIが使えない場合は検索ページ(HTML)から一覧だけ取る
      console.warn('[yahoo flea] search API failed, falling back to HTML:', err instanceof Error ? err.message : err)
      products = await this.scrapeSearchHtml(url, options)
    }
    if (products.length === 0) {
      throw new ScraperError('検索結果が0件です', this.siteKey, url)
    }
    onPage?.(products.length, limit)
    return this.enrichDetails(products.slice(0, limit), options)
  }

  // 検索APIで一覧+状態・評価数・出品日時をまとめて取得する
  private async scrapeSearchApi(url: string, options: ScraperOptions): Promise<ScrapedProduct[]> {
    const { userAgent = DEFAULT_UA, timeoutMs = 15000, limit = 600, onPage } = options
    const all: ScrapedProduct[] = []
    const seen = new Set<string>()
    for (let offset = 0; offset < limit + SEARCH_API_PAGE_SIZE; offset += SEARCH_API_PAGE_SIZE) {
      const apiUrl = buildYahooFleaSearchApiUrl(url, offset, Math.min(SEARCH_API_PAGE_SIZE, limit))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let json: { totalResultsAvailable?: number; items?: YahooFleaSearchApiItem[] }
      try {
        const res = await fetch(apiUrl, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3' },
          signal: controller.signal,
        })
        if (!res.ok) throw new ScraperError(`HTTP ${res.status}: ${res.statusText}`, this.siteKey, apiUrl)
        json = await res.json()
      } finally {
        clearTimeout(timer)
      }
      const items = Array.isArray(json.items) ? json.items : []
      let added = 0
      for (const item of items) {
        const product = searchApiItemToProduct(item, this.siteKey)
        if (!product || seen.has(product.sourceItemId!)) continue
        seen.add(product.sourceItemId!)
        all.push(product)
        added += 1
        if (all.length >= limit) break
      }
      onPage?.(all.length, Math.min(limit, json.totalResultsAvailable ?? limit))
      const total = typeof json.totalResultsAvailable === 'number' ? json.totalResultsAvailable : null
      if (added === 0 || items.length < SEARCH_API_PAGE_SIZE || all.length >= limit) break
      if (total !== null && offset + SEARCH_API_PAGE_SIZE >= total) break
    }
    return all
  }

  private async scrapeSearchHtml(url: string, options: ScraperOptions): Promise<ScrapedProduct[]> {
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
    return allProducts.slice(0, limit)
  }

  // 検索結果には説明文・2枚目以降の画像(・発送日数)が無いため、商品ページを取得して
  // 補完する。Yahoo!フリマの制限(約15件/15分/IP)に従い、1回の実行では先頭
  // FLEA_DETAIL_PER_RUN 件だけ取得し、429が出たらそれ以上は取得しない。残りは
  // 抽出完了後に enrich-details が補完する。フリマ側の検索に混ざるヤフオク出品は
  // ヤフオク側の制限で扱う。
  private async enrichDetails(products: ScrapedProduct[], options: ScraperOptions): Promise<ScrapedProduct[]> {
    if (options.skipDetailEnrichment) return products
    const { userAgent = DEFAULT_UA, timeoutMs = 15000, onPage } = options
    const fleaIndexes = products.map((p, i) => (p.sourceSite === this.siteKey ? i : -1)).filter(i => i >= 0).slice(0, FLEA_DETAIL_PER_RUN)
    const auctionIndexes = products.map((p, i) => (p.sourceSite === 'yahoo_auction' ? i : -1)).filter(i => i >= 0)
    const results = [...products]
    let rateLimited = false
    let failed = 0

    const fetchDetail = async (product: ScrapedProduct, retries: number): Promise<ScrapedProduct> => {
      const html = await fetchWithRetry(product.sourceUrl, {
        userAgent, timeoutMs, intervalMs: DETAIL_INTERVAL_MS, retries, siteKey: this.siteKey,
      })
      const detail = product.sourceSite === 'yahoo_auction'
        ? new (await import('./yahoo_auction')).YahooAuctionScraper().parse(cheerio.load(html), product.sourceUrl)
        : this.parse(cheerio.load(html), product.sourceUrl)
      return mergeDetail(product, detail)
    }

    // フリマ商品: 1件ずつ間隔を置いて、429が出たら打ち切る
    const startedAt = Date.now()
    let done = 0
    for (const index of fleaIndexes) {
      if (rateLimited || Date.now() - startedAt > DETAIL_TIME_BUDGET_MS) break
      try {
        results[index] = await fetchDetail(products[index], DETAIL_RETRIES)
      } catch (err) {
        if (err instanceof RateLimitedError) { rateLimited = true; break }
        failed += 1
        console.error('[yahoo flea enrich] failed for', products[index].sourceItemId, err instanceof Error ? err.message : err)
      }
      done += 1
      onPage?.(done, fleaIndexes.length + auctionIndexes.length)
      await new Promise(resolve => setTimeout(resolve, DETAIL_INTERVAL_MS))
    }

    // フリマ検索に混ざったヤフオク出品: ヤフオク側のペースで取得する
    if (auctionIndexes.length > 0) {
      const { results: auctionResults } = await mapThrottled(auctionIndexes.map(i => products[i]), async (product) => {
        try {
          return await fetchDetail(product, 2)
        } catch (err) {
          failed += 1
          console.error('[yahoo flea enrich] auction item failed for', product.sourceItemId, err instanceof Error ? err.message : err)
          return product
        }
      }, { concurrency: 3, intervalMs: 250, timeBudgetMs: DETAIL_TIME_BUDGET_MS, onProgress: (n) => onPage?.(done + n, fleaIndexes.length + auctionIndexes.length) })
      auctionIndexes.forEach((index, i) => { results[index] = auctionResults[i] })
    }

    const notFetched = products.filter(p => p.sourceSite === this.siteKey).length - fleaIndexes.length
    if (failed > 0 || rateLimited || notFetched > 0) {
      console.warn(`[yahoo flea enrich] 商品ページ: 取得${done}件 / 失敗${failed}件 / 429で打ち切り=${rateLimited} / 未取得${notFetched + (fleaIndexes.length - done)}件は抽出後に補完`)
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
