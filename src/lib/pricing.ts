export interface ProfitCalcParams {
  purchasePriceJpy: number
  jpyPerUsd: number
  ebayFeeRate: number
  targetProfitRate: number
  shippingUsd: number
  fixedCostUsd: number
}

export interface ProfitCalcResult {
  salePriceUsd: number
  costUsd: number
  profitUsd: number
}

export function validateProfitParams(p: ProfitCalcParams): string | null {
  if (!isFinite(p.purchasePriceJpy) || p.purchasePriceJpy <= 0) return '仕入価格は0より大きい値を入力してください'
  if (!isFinite(p.jpyPerUsd) || p.jpyPerUsd <= 0) return '為替レートは0より大きい値を入力してください'
  if (!isFinite(p.ebayFeeRate) || p.ebayFeeRate < 0) return 'eBay手数料率は0以上にしてください'
  if (!isFinite(p.targetProfitRate) || p.targetProfitRate < 0) return '目標利益率は0以上にしてください'
  if (p.ebayFeeRate + p.targetProfitRate >= 1) return 'eBay手数料率 + 目標利益率は100%未満にしてください'
  if (!isFinite(p.shippingUsd) || p.shippingUsd < 0) return '海外送料は0以上にしてください'
  if (!isFinite(p.fixedCostUsd) || p.fixedCostUsd < 0) return '固定費は0以上にしてください'
  return null
}

export function calcProfit(p: ProfitCalcParams): ProfitCalcResult {
  const costUsd = p.purchasePriceJpy / p.jpyPerUsd
  const salePriceUsd = Math.ceil(
    (costUsd + p.shippingUsd + p.fixedCostUsd) /
    (1 - p.ebayFeeRate - p.targetProfitRate),
  )
  const profitUsd = salePriceUsd * (1 - p.ebayFeeRate) - costUsd - p.shippingUsd - p.fixedCostUsd
  return { salePriceUsd, costUsd, profitUsd }
}

export function isSafePriceUsd(price: number): boolean {
  return isFinite(price) && price > 0
}

export const ALLOWED_CONDITIONS = new Set(['新品', '新品同様', '良い', '普通', '中古', 'ジャンク'])

export const PRODUCT_WRITE_WHITELIST = new Set([
  'ebay_title',
  'ebay_price',
  'ebay_condition',
  'purchase_price_jpy',
  // ebay_description, ebay_images, ebay_category_id は Phase 2 で追加
])

/** サーバー側フィールド検証。エラーメッセージを返す。問題なければ null。 */
export function validateProductFields(fields: Record<string, unknown>): string | null {
  if ('ebay_title' in fields) {
    const t = fields.ebay_title
    if (typeof t !== 'string' || t.length === 0 || t.length > 80) {
      return `ebay_title は1〜80文字にしてください (現在: ${typeof t === 'string' ? t.length : typeof t}文字)`
    }
  }
  if ('ebay_price' in fields) {
    const p = fields.ebay_price
    if (p !== null) {
      if (typeof p !== 'number' || !isFinite(p) || p <= 0) {
        return `ebay_price は0より大きい有限数にしてください (値: ${p})`
      }
    }
  }
  if ('ebay_condition' in fields) {
    const c = fields.ebay_condition
    if (typeof c !== 'string' || !ALLOWED_CONDITIONS.has(c)) {
      return `ebay_condition が不正です。許可値: ${[...ALLOWED_CONDITIONS].join(', ')}`
    }
  }
  if ('purchase_price_jpy' in fields) {
    const v = fields.purchase_price_jpy
    if (v !== null) {
      if (typeof v !== 'number' || !isFinite(v) || v < 0) {
        return `purchase_price_jpy は0以上の有限数にしてください (値: ${v})`
      }
    }
  }
  if ('ebay_images' in fields) {
    const imgs = fields.ebay_images
    if (!Array.isArray(imgs) || imgs.some((u) => typeof u !== 'string')) {
      return 'ebay_images は文字列URLの配列にしてください'
    }
  }
  return null
}
