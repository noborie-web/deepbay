import { ScraperError } from './types'
import type { ScrapedProduct, ScraperOptions } from './types'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja-JP,ja;q=0.9',
  'Origin': 'https://jp.mercari.com',
  'Referer': 'https://jp.mercari.com/',
  'X-Platform': 'web',
}

// ---- DPoP utility ----

function base64url(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64urlStr(str: string): string {
  return base64url(new TextEncoder().encode(str))
}

interface DPoPContext {
  keyPair: CryptoKeyPair
  publicJwk: JsonWebKey
  uuid: string
}

let _dpopCtx: DPoPContext | null = null

async function getDPoPContext(): Promise<DPoPContext> {
  if (!_dpopCtx) {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign'],
    )
    const full = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const publicJwk: JsonWebKey = { crv: full.crv, kty: full.kty, x: full.x, y: full.y }
    _dpopCtx = { keyPair, publicJwk, uuid: crypto.randomUUID() }
  }
  return _dpopCtx
}

export async function _generateDPoP(htu: string, htm: string, ctx: DPoPContext): Promise<string> {
  return generateDPoP(htu, htm, ctx)
}
export async function _getDPoPContext(): Promise<DPoPContext> {
  return getDPoPContext()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _toProduct(item: any, url: string) { return toProduct(item, url) }
export function _getMultiNumberParam(params: URLSearchParams, key: string) { return getMultiNumberParam(params, key) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _extractImages(item: any) { return extractImages(item) }

async function generateDPoP(htu: string, htm: string, ctx: DPoPContext): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: ctx.publicJwk }
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID().replace(/-/g, ''),
    htu,
    htm,
    uuid: ctx.uuid,
  }
  const signingInput = `${base64urlStr(JSON.stringify(header))}.${base64urlStr(JSON.stringify(payload))}`
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    ctx.keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64url(new Uint8Array(sig))}`
}

// ----------------------

function getMultiNumberParam(params: URLSearchParams, key: string): number[] {
  return params
    .getAll(key)
    .flatMap((value) => value.split(','))
    .filter((s) => s !== '')
    .map(Number)
    .filter(Number.isFinite)
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function getMetaContent(html: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tag = html.match(
    new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escapedKey}["'][^>]*>`, 'i'),
  )?.[0]
  const content = tag?.match(/\scontent=["']([^"']*)["']/i)?.[1]
  return content ? decodeHtml(content) : ''
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImages(item: any): string[] {
  const candidates = [
    ...(Array.isArray(item.photos) ? item.photos : []),
    ...(Array.isArray(item.images) ? item.images : []),
    ...(Array.isArray(item.thumbnails) ? item.thumbnails : []),
  ]

  return [...new Set(candidates
    .map((image: string | {
      imageUrl?: string
      image_url?: string
      photoUrl?: string
      photo_url?: string
      uri?: string
      url?: string
    }) => {
      if (typeof image === 'string') return image
      return image.imageUrl
        ?? image.image_url
        ?? image.photoUrl
        ?? image.photo_url
        ?? image.uri
        ?? image.url
        ?? ''
    })
    .filter((image: string) => /^https?:\/\//.test(image)))]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProduct(item: any, url: string): ScrapedProduct {
  const itemId: string = item.id ?? item.item_id ?? ''
  const images = extractImages(item)
  const status = typeof item.status === 'string' ? item.status.toUpperCase() : ''
  const availability: ScrapedProduct['availability'] = status.includes('SOLD_OUT') || status.includes('TRADING')
    ? 'sold_out'
    : status.includes('ON_SALE')
      ? 'available'
      : 'unknown'

  // 出品者URL(危険セラー除外の個別商品判定用)。実データ確認: entities:search /
  // items/get のレスポンスは出品者IDをitem.sellerIdに直接持つ(item.seller等の
  // ネストされたオブジェクトではない)。
  const sellerId: string | null = item.sellerId ?? item.seller_id ?? null
  const sellerUrl: string | null = sellerId ? `https://jp.mercari.com/user/profile/${sellerId}` : null

  // 評価数: seller情報から複数パスを試みる
  const seller = item.seller ?? item.sellerInfo ?? null
  let sellerRatingCount: number | null = null
  if (seller) {
    // num_ratings が直接ある場合
    if (typeof seller.num_ratings === 'number') sellerRatingCount = seller.num_ratings
    // ratings オブジェクトがある場合 → good + bad の合計
    else if (seller.ratings) {
      const g = seller.ratings.good ?? 0
      const b = seller.ratings.bad ?? 0
      if (g + b > 0) sellerRatingCount = g + b
    }
    // evaluation_count / ratingCount
    else if (typeof seller.evaluation_count === 'number') sellerRatingCount = seller.evaluation_count
    else if (typeof seller.ratingCount === 'number') sellerRatingCount = seller.ratingCount
  }

  // 発送日数: shipping_duration から取得
  // APIレスポンス例: { min: 1, max: 2 } または "1~2日で発送"
  const sd = item.shipping_duration ?? item.shippingDuration ?? item.shipping_payer ?? null
  let shippingDays: number | null = null
  if (sd && typeof sd === 'object') {
    if (typeof sd.min === 'number') shippingDays = sd.min
    else if (typeof sd.max === 'number') shippingDays = sd.max
  } else if (typeof sd === 'string') {
    const m = sd.match(/(\d+)/)
    if (m) shippingDays = parseInt(m[1], 10)
  }
  // フォールバック: shipping_duration_days
  if (shippingDays === null && typeof item.shipping_duration_days === 'number') {
    shippingDays = item.shipping_duration_days
  }

  // 最終更新日: Unix秒またはISO文字列
  const updatedRaw = item.updated ?? item.updated_at ?? item.updatedAt ?? item.created ?? null
  let sourceUpdatedAt: string | null = null
  if (updatedRaw != null) {
    const ms = (typeof updatedRaw === 'number' || (typeof updatedRaw === 'string' && /^\d+$/.test(updatedRaw)))
      ? Number(updatedRaw) * 1000
      : updatedRaw
    try {
      const d = new Date(ms)
      if (isFinite(d.getTime())) sourceUpdatedAt = d.toISOString()
    } catch { /* invalid date → null */ }
  }

  return {
    sourceUrl: itemId ? `https://jp.mercari.com/item/${itemId}` : url,
    sourceSite: 'mercari',
    sourceItemId: itemId,
    title: item.name ?? '',
    price: (() => { if (item.price == null) return null; const n = Number(item.price); return isFinite(n) ? n : null })(),
    description: item.description ?? '',
    images,
    condition: item.item_condition?.name ?? item.itemCondition?.name ?? null,
    category: item.item_category?.name ?? item.itemCategory?.name ?? null,
    sellerRatingCount,
    shippingDays,
    sourceUpdatedAt,
    availability,
    sellerUrl,
  }
}

export class MercariScraper {
  name = 'メルカリ'
  siteKey = 'mercari'
  // セラーページは/s/{id}(旧来の短縮リンク)と/user/profile/{id}(実際の商品
  // ページからリンクされる現行の正式なプロフィールURL)の両方が有効。
  urlPattern = /mercari\.com\/(?:jp\/items\/[^/?#]+|item\/[^/?#]+|s\/[^/?#]+|user\/profile\/[^/?#]+|search(?:[/?#]|$))/

  matches(url: string): boolean {
    if (this.urlPattern.test(url)) return true
    // 検索URL: jp.mercari.com/search?keyword=...
    return /mercari\.com\/search/.test(url)
  }

  async scrape(url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    const { limit = 100 } = options

    // 検索ページ: jp.mercari.com/search?keyword=...
    if (/mercari\.com\/search/.test(url)) {
      return this.scrapeSearch(url, limit, options)
    }

    // セラーページ: jp.mercari.com/s/{sellerId} または jp.mercari.com/user/profile/{sellerId}
    const sellerMatch = url.match(/mercari\.com\/(?:s|user\/profile)\/([^/?#]+)/)
    if (sellerMatch) {
      return this.scrapeSellerPage(sellerMatch[1], url, limit, options)
    }

    // 単品ページ: jp.mercari.com/item/{itemId}
    const itemMatch = url.match(/\/(?:items\/|item\/)([^/?#]+)/)
    if (itemMatch) {
      const product = await this.scrapeItem(itemMatch[1], url)
      return [product]
    }

    throw new ScraperError('Invalid Mercari URL', this.siteKey, url)
  }

  private async scrapeSearch(url: string, limit: number, options: ScraperOptions): Promise<ScrapedProduct[]> {
    const srcParams = new URL(url).searchParams

    // sort マッピング（新API仕様: SORT_SCORE / SORT_PRICE / SORT_CREATED_TIME / SORT_NUM_LIKES）
    const sortMap: Record<string, { sort: string; order: string }> = {
      num_likes:    { sort: 'SORT_NUM_LIKES',    order: 'ORDER_DESC' },
      price_asc:    { sort: 'SORT_PRICE',        order: 'ORDER_ASC'  },
      price_desc:   { sort: 'SORT_PRICE',        order: 'ORDER_DESC' },
      created_time: { sort: 'SORT_CREATED_TIME', order: 'ORDER_DESC' },
    }
    const sortKey = srcParams.get('sort') ?? 'created_time'
    const { sort: sortValue, order: orderValue } = sortMap[sortKey] ?? { sort: 'SORT_CREATED_TIME', order: 'ORDER_DESC' }

    // status マッピング（新API: STATUS_ON_SALE / STATUS_SOLD_OUT）
    const statusMap: Record<string, string> = {
      on_sale:  'STATUS_ON_SALE',
      sold_out: 'STATUS_SOLD_OUT',
    }
    const statusParam = srcParams.get('status') ?? 'on_sale'
    const statusValue = statusMap[statusParam] ?? 'STATUS_ON_SALE'

    // searchCondition を構築
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchCondition: Record<string, any> = {
      keyword:        srcParams.get('keyword') ?? '',
      excludeKeyword: srcParams.get('exclude_keyword') ?? '',
      sort:           sortValue,
      order:          orderValue,
      status:         [statusValue],
      sizeId:         [],
      categoryId:     [],
      brandId:        [],
      sellerId:       [],
      itemConditionId: [],
      shippingPayerId: [],
      shippingFromArea: [],
      shippingMethod: [],
      colorId:        [],
      hasCoupon:      false,
      attributes:     [],
      itemTypes:      [],
      skuIds:         [],
    }

    const priceMin = srcParams.get('price_min')
    if (priceMin) searchCondition.priceMin = parseInt(priceMin, 10)

    const priceMax = srcParams.get('price_max')
    if (priceMax) searchCondition.priceMax = parseInt(priceMax, 10)

    const conditionIds = getMultiNumberParam(srcParams, 'item_condition_id')
    if (conditionIds.length > 0) searchCondition.itemConditionId = conditionIds

    const categoryIds = getMultiNumberParam(srcParams, 'category_id')
    if (categoryIds.length > 0) searchCondition.categoryId = categoryIds

    const shippingPayerIds = getMultiNumberParam(srcParams, 'shipping_payer_id')
    if (shippingPayerIds.length > 0) searchCondition.shippingPayerId = shippingPayerIds

    return this.runSearchApi(searchCondition, limit, url, options)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async runSearchApi(searchCondition: Record<string, any>, limit: number, url: string, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    const SEARCH_URL = 'https://api.mercari.jp/v2/entities:search'
    const dpopCtx = await getDPoPContext()
    const allProducts: ScrapedProduct[] = []
    let pageToken: string | undefined
    const pageSize = Math.min(limit, 120)
    // searchSessionId は検索1セッション単位で固定（mercapiに準拠）
    const searchSessionId = crypto.randomUUID().replace(/-/g, '')
    // ページネーションの暴走防止用の安全上限（1ページ最低1件と仮定してlimit分のページ数+バッファ）
    const maxPages = limit + 10
    let pageCount = 0

    while (allProducts.length < limit) {
      pageCount += 1
      if (pageCount > maxPages) break

      const dpop = await generateDPoP(SEARCH_URL, 'POST', dpopCtx)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reqBody: Record<string, any> = {
        userId: '',
        pageSize,
        pageToken: pageToken ?? '',
        searchSessionId,
        indexRouting: 'INDEX_ROUTING_UNSPECIFIED',
        thumbnailTypes: [],
        searchCondition,
        defaultDatasets: [],
        serviceFrom: 'suruga',
      }

      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json', 'DPoP': dpop },
        body: JSON.stringify(reqBody),
      })

      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 500)
        throw new ScraperError(`Search API error: ${res.status} ${text}`, this.siteKey, url)
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json()
      const items: unknown[] = json?.items ?? json?.data ?? []

      if (!Array.isArray(items) || items.length === 0) break

      allProducts.push(...items.map((item) => toProduct(item, url)))

      // 注意: Mercariの検索APIはpageSizeより少ない件数を返すことがあっても、
      // nextPageTokenが有効であれば後続ページにさらに結果が存在する(numFoundで確認済み)。
      // そのため「返却件数がpageSize未満」を終了条件にしてはいけない。
      // 終了条件は「nextPageTokenが無い」または「前回と同じtoken(APIが進まない)」のみとする。
      const nextPageToken: string | undefined = json?.meta?.nextPageToken ?? json?.nextPageToken
      if (!nextPageToken || nextPageToken === pageToken) break
      pageToken = nextPageToken
    }

    if (allProducts.length === 0) {
      throw new ScraperError('検索結果が0件です', this.siteKey, url)
    }

    return this.enrichImages(allProducts.slice(0, limit), url, options)
  }

  // 旧来の `api.mercari.jp/v2/entities/@{id}/items` は廃止されており(実データで404を確認済み)、
  // 現在は単品検索と同じ entities:search エンドポイントに sellerId を指定して取得する。
  private async scrapeSellerPage(sellerId: string, url: string, limit: number, options: ScraperOptions = {}): Promise<ScrapedProduct[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchCondition: Record<string, any> = {
      keyword: '',
      excludeKeyword: '',
      sort: 'SORT_CREATED_TIME',
      order: 'ORDER_DESC',
      status: ['STATUS_ON_SALE'],
      sizeId: [],
      categoryId: [],
      brandId: [],
      sellerId: [sellerId],
      itemConditionId: [],
      shippingPayerId: [],
      shippingFromArea: [],
      shippingMethod: [],
      colorId: [],
      hasCoupon: false,
      attributes: [],
      itemTypes: [],
      skuIds: [],
    }

    return this.runSearchApi(searchCondition, limit, url, options)
  }

  private async scrapeItem(itemId: string, url: string): Promise<ScrapedProduct> {
    try {
      const item = await this.fetchItemDetail(itemId)
      if (item?.name) return toProduct(item, url)
    } catch {
      // Vercelなど一部の実行環境で詳細APIが404になる場合は商品ページへ切り替える。
    }
    return this.scrapeItemPage(itemId, url)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchItemDetail(itemId: string): Promise<any> {
    const itemUrl = new URL('https://api.mercari.jp/items/get')
    itemUrl.searchParams.set('id', itemId)
    const endpoint = itemUrl.toString()
    const dpop = await generateDPoP(endpoint, 'GET', await getDPoPContext())
    const res = await fetch(endpoint, {
      headers: { ...HEADERS, 'DPoP': dpop },
    })

    if (!res.ok) {
      throw new Error(`Item API error: ${res.status}`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    return json?.data ?? json?.item ?? json
  }

  private async enrichImages(
    products: ScrapedProduct[],
    url: string,
    options: ScraperOptions = {},
  ): Promise<ScrapedProduct[]> {
    const enriched: ScrapedProduct[] = []
    const concurrency = 8

    for (let index = 0; index < products.length; index += concurrency) {
      const chunk = products.slice(index, index + concurrency)
      const results = await Promise.all(chunk.map(async (product) => {
        if (!product.sourceItemId) return product

        try {
          const detail = await this.fetchItemDetail(product.sourceItemId)
          const detailImages = extractImages(detail)
          return detailImages.length > 0
            ? { ...product, images: detailImages }
            : product
        } catch {
          // 詳細APIが404でも、Mercari CDNの連番画像を確認して全画像を補完する。
          const probedImages = await this.probeItemImages(product.sourceItemId)
          return probedImages.length > 0
            ? { ...product, images: probedImages }
            : product
        }
      }))
      enriched.push(...results)
      options.onPage?.(enriched.length, products.length)
    }

    if (enriched.length === 0) {
      throw new ScraperError('商品画像を取得できませんでした', this.siteKey, url)
    }
    return enriched
  }

  private async scrapeItemPage(itemId: string, url: string): Promise<ScrapedProduct> {
    const pageUrl = `https://jp.mercari.com/item/${encodeURIComponent(itemId)}`
    const res = await fetch(pageUrl, { headers: HEADERS })
    if (!res.ok) {
      throw new ScraperError(`Item page error: ${res.status}`, this.siteKey, url)
    }

    const html = await res.text()
    const title = getMetaContent(html, 'og:title').replace(/\s+by メルカリ\s*$/, '')
    const priceRaw = getMetaContent(html, 'product:price:amount')
    if (!title) {
      throw new ScraperError('Item data not found', this.siteKey, url)
    }

    const images = await this.probeItemImages(itemId)
    const ogImage = getMetaContent(html, 'og:image')
    return toProduct({
      id: itemId,
      name: title,
      price: priceRaw || null,
      description: '',
      photos: images.length > 0 ? images : [ogImage].filter(Boolean),
    }, url)
  }

  private async probeItemImages(itemId: string): Promise<string[]> {
    const images: string[] = []
    // eBay側のPicURL上限に合わせ、最大12枚まで連番画像の存在を確認する。
    for (let index = 1; index <= 12; index += 1) {
      const imageUrl = `https://static.mercdn.net/item/detail/orig/photos/${encodeURIComponent(itemId)}_${index}.jpg`
      try {
        const res = await fetch(imageUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': HEADERS['User-Agent'] },
        })
        if (!res.ok) break
        images.push(imageUrl)
      } catch {
        break
      }
    }
    return images
  }
}
