import { convertListingPrice, currencyForSite } from './ebay-sites'
import { fetchJpyRate } from './exchange-rate'

// ---------------------------------------------------------------------------
// UK/AU出品の価格追従
//
// ユーザー要望(2026-09-25): UK・AUにも出品し、価格追従もさせたい。ただし
// 「混在しないよう細心の注意が必要」「赤字になるのは絶対に避けて」。
//
// 仕入先チェックは「出品時の利益額(円)を維持」してUSD価格(products.ebay_price)
// を再計算する。UK/AUの出品価格は、CSV出力と同じ考え方で
//   円価値 = USD価格 × 出品時の円/USDレート
//   出品通貨の価格 = 円価値 ÷ 現在の円/出品通貨レート
// と換算する。こうすると維持している利益額(円)がそのまま各サイトに反映される。
// ---------------------------------------------------------------------------

// 仕入価格が下がっていないのに、この割合を超えて値下げする計算結果は適用しない
// (為替の取得ミス・通貨の取り違えによる大幅値下げの安全網)。
export const SITE_PRICE_DROP_GUARD_RATE = 0.85

export interface SiteReviseInput {
  // 関税率を米国だけに適用する設定のときの補正率(UK/AUは1未満。既定1)
  priceAdjustment?: number
  // 在庫一覧の現在価格(出品通貨建て)
  currentPrice: number | null
  // 仕入先チェックが維持した出品価格(USD)と、その計算に使った円/USDレート
  usdPrice: number | null
  jpyPerUsd: number | null
  // 出品のサイト(US/UK/AU)
  siteId: string | null
  // 出品通貨の現在レート(円/通貨)。USはこの値を使わない。
  jpyPerCurrency: number | null
}

export type SiteReviseDecision =
  | { action: 'revise'; price: number; currency: string }
  | { action: 'skip'; reason: 'unchanged' | 'no_price' | 'no_rate' | 'guarded' }

/**
 * 出品1件について、eBayに送る価格を決める。
 * 送らない場合は理由を返す(結果に件数として残し、黙って飛ばさない)。
 */
export function decideSiteRevisePrice(input: SiteReviseInput): SiteReviseDecision {
  const currency = currencyForSite(input.siteId)
  const current = toPositiveNumber(input.currentPrice)
  const usdPrice = toPositiveNumber(input.usdPrice)
  if (usdPrice === null) return { action: 'skip', reason: 'no_price' }

  let target: number | null
  if (currency === 'USD') {
    target = usdPrice
  } else {
    const jpyPerUsd = toPositiveNumber(input.jpyPerUsd)
    const jpyPerCurrency = toPositiveNumber(input.jpyPerCurrency)
    if (jpyPerUsd === null || jpyPerCurrency === null) return { action: 'skip', reason: 'no_rate' }
    target = convertListingPrice(usdPrice, jpyPerUsd, jpyPerCurrency)
    // 関税率を米国だけに適用する設定なら、CSV出力と同じ補正をかける
    const adjustment = toPositiveNumber(input.priceAdjustment)
    if (target !== null && adjustment !== null && adjustment !== 1) {
      target = Math.ceil(target * adjustment * 100) / 100
    }
  }
  if (target === null || !(target > 0)) return { action: 'skip', reason: 'no_price' }

  if (current === null) return { action: 'revise', price: target, currency }
  // 端数(0.5未満)の違いでeBayを叩かない
  if (Math.abs(target - current) <= 0.5) return { action: 'skip', reason: 'unchanged' }
  if (target < current * SITE_PRICE_DROP_GUARD_RATE) return { action: 'skip', reason: 'guarded' }

  return { action: 'revise', price: target, currency }
}

function toPositiveNumber(value: unknown): number | null {
  // PostgRESTのnumeric列は文字列で返るため、必ず数値化してから判定する
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

/**
 * 出品に出てくる通貨の円レートをまとめて取得する。
 * 取得できなかった通貨は含めない(その通貨の出品は価格改定を行わない)。
 */
export async function loadJpyRates(
  currencies: Iterable<string>,
  // 円高に備えた為替調整(出品時と同じ基準で追従するため)
  adjust?: (currency: string, rate: number, jpyPerUsd: number) => number,
): Promise<Map<string, number>> {
  const rates = new Map<string, number>()
  let jpyPerUsd = 0
  if (adjust) {
    try {
      jpyPerUsd = (await fetchJpyRate('USD')).rate
    } catch {
      jpyPerUsd = 0
    }
  }
  const unique = Array.from(new Set(Array.from(currencies).map(c => (c || 'USD').toUpperCase())))
  await Promise.all(unique.map(async currency => {
    try {
      const rate = await fetchJpyRate(currency)
      if (rate.rate > 0) {
        rates.set(currency, adjust && jpyPerUsd > 0 ? adjust(currency, rate.rate, jpyPerUsd) : rate.rate)
      }
    } catch (error) {
      console.warn(`[inventory-site-pricing] failed to load ${currency}/JPY rate:`, error instanceof Error ? error.message : error)
    }
  }))
  return rates
}
