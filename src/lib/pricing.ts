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
  if (!isFinite(p.jpyPerUsd) || p.jpyPerUsd <= 0) return '為替レートは0より大きい値を入力してください'
  if (p.ebayFeeRate + p.targetProfitRate >= 1) return 'eBay手数料率 + 目標利益率は100%未満にしてください'
  if (p.ebayFeeRate < 0 || p.targetProfitRate < 0) return '手数料率・利益率は0以上にしてください'
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

export const PRODUCT_WRITE_WHITELIST = new Set([
  'ebay_title',
  'ebay_price',
  'ebay_condition',
  'purchase_price_jpy',
  'ebay_description',
  'ebay_images',
  'ebay_category_id',
])
