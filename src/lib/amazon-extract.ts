import type { ScrapedProduct } from '@/lib/scrapers'
import { loadAmazonCredentials } from '@/lib/amazon-credentials'
import {
  BATCH_SIZE,
  fetchAccessToken,
  fetchCatalogItems,
  fetchItemOffersBatch,
} from '@/lib/amazon-spapi'
import { pickBestNewOffer, type SpApiOffersPayload } from '@/lib/amazon-offers'
import type { SupabaseClient } from '@supabase/supabase-js'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
//
// 既存ツールの実測レート制限:
//   getItemOffersBatch 0.1 req/s (20 ASIN/回 = 実効2 ASIN/s) ← ここが律速
//   カタログ側は待ち時間に並行させる
const OFFERS_INTERVAL_MS = 10_000

export interface AmazonExtractResult {
  products: ScrapedProduct[]
  /** 価格を取得できず、次回に回したASIN(価格0として確定させない) */
  pricingFailed: string[]
  /** 新品のオファーが無く、仕入れできないASIN */
  noOffer: string[]
  /** 時間切れで処理しなかったASIN */
  skipped: string[]
  /** FBAのみ指定で、自社発送しか無く対象外にしたASIN */
  notFba: string[]
}

export interface AmazonExtractOptions {
  signal?: AbortSignal
  /** この時間を超えたら残りは処理しない(cron/ルートの実行時間に収めるため) */
  timeBudgetMs?: number
  /** テスト用: バッチ間の待ち時間 */
  offersIntervalMs?: number
  /** FBA(Amazon発送)のオファーだけを対象にする */
  fbaOnly?: boolean
}

/**
 * ASINの一覧から、抽出パイプラインに流せる商品を作る。
 * 以降の処理(翻訳・価格計算・除外・重複判定)は既存の仕入先と共通。
 */
export async function fetchAmazonProducts(
  db: SupabaseClient,
  userId: string,
  asins: string[],
  options: AmazonExtractOptions = {},
): Promise<AmazonExtractResult> {
  const result: AmazonExtractResult = { products: [], pricingFailed: [], noOffer: [], skipped: [], notFba: [] }
  if (asins.length === 0) return result

  const credentials = await loadAmazonCredentials(db, userId)
  if (!credentials) {
    throw new Error('Amazonと接続されていません。抽出設定の「仕入先連携」で接続してください。')
  }
  const { accessToken } = await fetchAccessToken(credentials, { signal: options.signal })

  const startedAt = Date.now()
  const budgetMs = options.timeBudgetMs ?? Number.POSITIVE_INFINITY
  const intervalMs = options.offersIntervalMs ?? OFFERS_INTERVAL_MS

  for (let index = 0; index < asins.length; index += BATCH_SIZE) {
    const chunk = asins.slice(index, index + BATCH_SIZE)
    const elapsed = Date.now() - startedAt
    if (elapsed >= budgetMs) {
      result.skipped.push(...asins.slice(index))
      break
    }

    // 律速はオファー側。カタログはその待ち時間に並行させる
    const [catalog, offers] = await Promise.all([
      fetchCatalogItems(accessToken, chunk, {
        marketplaceId: credentials.marketplaceId,
        signal: options.signal,
      }).catch(() => new Map()),
      fetchItemOffersBatch(accessToken, chunk, {
        marketplaceId: credentials.marketplaceId,
        signal: options.signal,
      }),
    ])

    result.pricingFailed.push(...offers.failed)

    for (const asin of chunk) {
      if (offers.failed.includes(asin)) continue
      const picked = pickBestNewOffer(offers.payloads.get(asin) as SpApiOffersPayload | undefined)
      if (!picked) {
        result.noOffer.push(asin)
        continue
      }
      if (options.fbaOnly && !picked.isFba) {
        // 「新品が無い」とは理由が違うので分けて数える
        result.notFba.push(asin)
        continue
      }
      const item = catalog.get(asin)
      result.products.push({
        sourceUrl: `https://www.amazon.co.jp/dp/${asin}`,
        sourceSite: 'amazon',
        sourceItemId: asin,
        title: item?.title ?? asin,
        // 送料は仕入値に含める(eBay価格の計算で原価として扱うため)
        price: Math.round(picked.listingPriceJpy + picked.shippingJpy),
        description: '',
        images: item?.imageUrls ?? [],
        condition: '新品',
        sellerRatingCount: null,
        sellerBadRatingCount: null,
        shippingDays: null,
        sourceUpdatedAt: null,
        sellerUrl: null,
        availability: 'available',
        category: null,
        rawData: {
          asin,
          brand: item?.brand ?? null,
          is_fba: picked.isFba,
          listing_price_jpy: picked.listingPriceJpy,
          shipping_jpy: picked.shippingJpy,
          offer_count: picked.offerCount,
          excluded_unbuyable: picked.excludedUnbuyable,
        },
      } as ScrapedProduct)
    }

    // 次のバッチまで待つ(最後のチャンクでは待たない)
    const hasMore = index + BATCH_SIZE < asins.length
    if (hasMore && intervalMs > 0) {
      const remaining = budgetMs - (Date.now() - startedAt)
      if (remaining <= intervalMs) {
        result.skipped.push(...asins.slice(index + BATCH_SIZE))
        break
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// 仕入先チェック用
// ---------------------------------------------------------------------------

export interface AmazonSupplierStatus {
  /** 新品で購入できるオファーがあるか */
  available: boolean
  /** 本体価格+送料(円)。買えない場合は null */
  priceJpy: number | null
  isFba: boolean
}

/**
 * 在庫チェック用に、ASINの現在の購入可否と価格を取る。
 *
 * 抽出時と違いカタログは取らない(商品名はAmazonのカタログなので変わらず、
 * 余計なAPI呼び出しとタイトル変更の誤検知を避けるため)。
 *
 * 取得できなかったASINは Map に入れない。呼び出し側は「売り切れ」ではなく
 * 「未確認」として扱うこと(HTMLの429を売り切れ扱いして64件を誤って
 * 取り下げた2026-09-22の事故と同じ考え方)。
 */
export async function fetchAmazonSupplierStatus(
  db: SupabaseClient,
  userId: string,
  asins: string[],
  options: { signal?: AbortSignal; timeBudgetMs?: number; offersIntervalMs?: number; fbaOnly?: boolean } = {},
): Promise<Map<string, AmazonSupplierStatus>> {
  const statuses = new Map<string, AmazonSupplierStatus>()
  if (asins.length === 0) return statuses

  const credentials = await loadAmazonCredentials(db, userId)
  // 未接続なら何も返さない = すべて「未確認」になる(売り切れ扱いしない)
  if (!credentials) return statuses

  const { accessToken } = await fetchAccessToken(credentials, { signal: options.signal })
  const startedAt = Date.now()
  const budgetMs = options.timeBudgetMs ?? Number.POSITIVE_INFINITY
  const intervalMs = options.offersIntervalMs ?? OFFERS_INTERVAL_MS

  for (let index = 0; index < asins.length; index += BATCH_SIZE) {
    if (Date.now() - startedAt >= budgetMs) break
    const chunk = asins.slice(index, index + BATCH_SIZE)
    const offers = await fetchItemOffersBatch(accessToken, chunk, {
      marketplaceId: credentials.marketplaceId,
      signal: options.signal,
    })

    for (const asin of chunk) {
      if (offers.failed.includes(asin)) continue
      const picked = pickBestNewOffer(offers.payloads.get(asin) as SpApiOffersPayload | undefined)
      if (!picked || (options.fbaOnly && !picked.isFba)) {
        statuses.set(asin, { available: false, priceJpy: null, isFba: false })
        continue
      }
      statuses.set(asin, {
        available: true,
        priceJpy: Math.round(picked.listingPriceJpy + picked.shippingJpy),
        isFba: picked.isFba,
      })
    }

    const hasMore = index + BATCH_SIZE < asins.length
    if (hasMore && intervalMs > 0) {
      if (budgetMs - (Date.now() - startedAt) <= intervalMs) break
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  return statuses
}

/** Amazonの商品URL(/dp/ASIN)からASINを取り出す。 */
export function asinFromSourceUrl(sourceUrl: string | null | undefined): string | null {
  if (!sourceUrl) return null
  return sourceUrl.toUpperCase().match(/\/DP\/([A-Z0-9]{10})/)?.[1] ?? null
}
