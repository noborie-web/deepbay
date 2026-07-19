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
      false,
      ['sign'],
    )
    const full = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    const publicJwk: JsonWebKey = { crv: full.crv, kty: full.kty, x: full.x, y: full.y }
    _dpopCtx = { keyPair, publicJwk, uuid: crypto.randomUUID() }
  }
  return _dpopCtx
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProduct(item: any, url: string): ScrapedProduct {
  const itemId: string = item.id ?? item.item_id ?? ''
  const images: string[] = (item.thumbnails ?? item.photos ?? [])
    .map((p: string | { imageUrl?: string; image_url?: string }) =>
      typeof p === 'string' ? p : (p.imageUrl ?? p.image_url ?? '')
    )
    .filter(Boolean)

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
  const sourceUpdatedAt: string | null = updatedRaw
    ? new Date(typeof updatedRaw === 'number' ? updatedRaw * 1000 : updatedRaw).toISOString()
    : null

  return {
    sourceUrl: `https://jp.mercari.com/item/${itemId}`,
    sourceSite: 'mercari',
    sourceItemId: itemId,
    title: item.name ?? '',
    price: typeof item.price === 'number' ? item.price : null,
    description: item.description ?? '',
    images,
    condition: item.item_condition?.name ?? item.itemCondition?.name ?? null,
    category: item.item_category?.name ?? item.itemCategory?.name ?? null,
    sellerRatingCount,
    shippingDays,
    sourceUpdatedAt,
  }
}

export class MercariScraper {
  name = 'メルカリ'
  siteKey = 'mercari'
  urlPattern = /mercari\.com\/(?:jp\/items\/[^/?#]+|item\/[^/?#]+|s\/[^/?#]+|search(?:[/?#]|$))/

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

    // セラーページ: jp.mercari.com/s/{sellerId}
    const sellerMatch = url.match(/mercari\.com\/s\/([^/?#]+)/)
    if (sellerMatch) {
      return this.scrapeSellerPage(sellerMatch[1], url, limit)
    }

    // 単品ページ: jp.mercari.com/item/{itemId}
    const itemMatch = url.match(/\/(?:items\/|item\/)([^/?#]+)/)
    if (itemMatch) {
      const product = await this.scrapeItem(itemMatch[1], url)
      return [product]
    }

    throw new ScraperError('Invalid Mercari URL', this.siteKey, url)
  }

  private async scrapeSearch(url: string, limit: number, _options: ScraperOptions): Promise<ScrapedProduct[]> {
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
      excludeKeyword: '',
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

    const conditionIds = srcParams.getAll('item_condition_id')
    if (conditionIds.length > 0) searchCondition.itemConditionId = conditionIds.map(Number)

    const categoryId = srcParams.get('category_id')
    if (categoryId) searchCondition.categoryId = [parseInt(categoryId, 10)]

    const shippingPayerId = srcParams.get('shipping_payer_id')
    if (shippingPayerId) searchCondition.shippingPayerId = [parseInt(shippingPayerId, 10)]

    const SEARCH_URL = 'https://api.mercari.jp/v2/entities:search'
    const dpopCtx = await getDPoPContext()
    const allProducts: ScrapedProduct[] = []
    let pageToken: string | undefined
    const pageSize = Math.min(limit, 120)
    // searchSessionId は検索1セッション単位で固定（mercapiに準拠）
    const searchSessionId = crypto.randomUUID().replace(/-/g, '')

    while (allProducts.length < limit) {
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

      pageToken = json?.meta?.nextPageToken ?? json?.nextPageToken
      if (!pageToken || items.length < pageSize) break
    }

    if (allProducts.length === 0) {
      throw new ScraperError('検索結果が0件です', this.siteKey, url)
    }

    return allProducts.slice(0, limit)
  }

  private async scrapeSellerPage(sellerId: string, url: string, limit: number): Promise<ScrapedProduct[]> {
    const params = new URLSearchParams({
      seller_id: sellerId,
      status: 'on_sale',
      limit: String(Math.min(limit, 120)),
      offset: '0',
    })

    const res = await fetch(`https://api.mercari.jp/v2/entities/@${sellerId}/items?${params}`, {
      headers: HEADERS,
    })

    if (!res.ok) {
      // フォールバック: 検索APIで試す
      return this.scrapeSellerViaSearch(sellerId, url, limit)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    const items: unknown[] = json?.data ?? json?.items ?? []
    if (!Array.isArray(items) || items.length === 0) {
      return this.scrapeSellerViaSearch(sellerId, url, limit)
    }

    return items.map((item) => toProduct(item, url))
  }

  private async scrapeSellerViaSearch(sellerId: string, url: string, limit: number): Promise<ScrapedProduct[]> {
    const body = JSON.stringify({
      sellerId,
      status: 'STATUS_TRADING',
      limit,
      offset: 0,
    })

    const res = await fetch('https://api.mercari.jp/v2/entities/search', {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body,
    })

    if (!res.ok) {
      throw new ScraperError(`Seller API error: ${res.status}`, this.siteKey, url)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    const items: unknown[] = json?.data ?? json?.items ?? []

    if (!Array.isArray(items) || items.length === 0) {
      throw new ScraperError('No items found for this seller', this.siteKey, url)
    }

    return items.map((item) => toProduct(item, url))
  }

  private async scrapeItem(itemId: string, url: string): Promise<ScrapedProduct> {
    const res = await fetch(`https://api.mercari.jp/v1/items/get_items_by_id?id=${itemId}`, {
      headers: HEADERS,
    })

    if (!res.ok) {
      throw new ScraperError(`Item API error: ${res.status}`, this.siteKey, url)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json()
    const item = json?.data ?? json?.item ?? json

    if (!item?.name) {
      throw new ScraperError('Item data not found', this.siteKey, url)
    }

    return toProduct(item, url)
  }
}
