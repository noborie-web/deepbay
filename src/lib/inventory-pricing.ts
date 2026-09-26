import type { SupabaseClient } from '@supabase/supabase-js'
import {
  calcTieredProfit,
  DEFAULT_AUTO_PRICING,
  findTierProfitJpy,
  validateTieredProfitParams,
  type ProfitTier,
} from '@/lib/pricing'

// 本番で確認した不具合: 仕入先チェックの価格再計算が「一括編集設定の利益率
// 方式(既定23%)」で計算していたため、ユーザーが価格一括編集の「段階利益」
// 方式(price_tier_settings: 手数料15%・送料¥6,000・広告4%・関税13%・
// 割引5%・仕入価格帯ごとの利益額)で設定した価格より約20%低い値になった。
// ユーザーが保存している段階利益設定を「そのユーザーの価格モデル」として
// 使い、仕入価格・為替の追従も同じ式で行う(手動設定価格と一致する)。
export interface TieredPricingModel {
  kind: 'tiered'
  tiers: ProfitTier[]
  ebayFeeRate: number
  shippingJpy: number
  fixedCostUsd: number
  adRate: number
  customsRate: number
  discountRate: number
  // ユーザー要望(2026-09-26): 関税率は米国向けの設定なので、UK/AU出品では
  // 適用しない(既定ON)。UK/AUの価格はこの分だけ安くなる。
  skipCustomsOutsideUs: boolean
}

export type PricingModel = TieredPricingModel | null

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

export function toPricingModel(row: Record<string, unknown> | null | undefined): PricingModel {
  if (!row || !Array.isArray(row.tiers) || row.tiers.length === 0) return null
  const tiers = (row.tiers as Array<Record<string, unknown>>).map(t => ({
    maxPurchaseJpy: typeof t.maxPurchaseJpy === 'number' ? t.maxPurchaseJpy : null,
    profitJpy: num(t.profitJpy, 0),
  }))
  return {
    kind: 'tiered',
    tiers,
    ebayFeeRate: num(row.ebay_fee_rate, DEFAULT_AUTO_PRICING.ebayFeeRate),
    shippingJpy: num(row.shipping_jpy, DEFAULT_AUTO_PRICING.shippingCostJpy),
    fixedCostUsd: num(row.fixed_cost_usd, DEFAULT_AUTO_PRICING.fixedCostUsd),
    adRate: num(row.ad_rate, 0),
    customsRate: num(row.customs_rate, 0),
    discountRate: num(row.discount_rate, 0),
    skipCustomsOutsideUs: row.skip_customs_outside_us !== false,
  }
}

/**
 * 出品サイトに応じた価格の補正率。
 * 関税率を米国だけに適用する設定のとき、US以外の価格は
 *   (1 - 手数料 - 広告 - 関税 - ディスカウント) / (1 - 手数料 - 広告 - ディスカウント)
 * 倍になる(例: 15/4/13/5% なら 0.63/0.76 ≒ 0.829)。
 */
export function sitePriceAdjustment(model: PricingModel, siteId: string | null | undefined): number {
  if (!model || !model.skipCustomsOutsideUs || model.customsRate <= 0) return 1
  if ((siteId ?? 'US').toUpperCase() === 'US') return 1
  const withCustoms = 1 - model.ebayFeeRate - model.adRate - model.customsRate - model.discountRate
  const withoutCustoms = 1 - model.ebayFeeRate - model.adRate - model.discountRate
  if (!(withCustoms > 0) || !(withoutCustoms > 0)) return 1
  return withCustoms / withoutCustoms
}

export async function loadPricingModel(db: SupabaseClient, userId: string): Promise<PricingModel> {
  try {
    const { data } = await db
      .from('price_tier_settings')
      .select('tiers, ebay_fee_rate, shipping_jpy, fixed_cost_usd, ad_rate, customs_rate, discount_rate, skip_customs_outside_us')
      .eq('user_id', userId)
      .maybeSingle()
    return toPricingModel(data as Record<string, unknown> | null)
  } catch {
    return null
  }
}

function tieredParams(model: TieredPricingModel, purchasePriceJpy: number, jpyPerUsd: number) {
  const profitJpy = findTierProfitJpy(purchasePriceJpy, model.tiers)
  if (profitJpy === null) return null
  const params = {
    purchasePriceJpy,
    profitJpy,
    jpyPerUsd,
    ebayFeeRate: model.ebayFeeRate,
    shippingUsd: model.shippingJpy / jpyPerUsd,
    fixedCostUsd: model.fixedCostUsd,
    adRate: model.adRate,
    customsRate: model.customsRate,
    discountRate: model.discountRate,
  }
  return validateTieredProfitParams(params) ? null : params
}

/** 価格モデルでeBay出品価格(USD)を計算する。計算できなければ null。 */
export function calcModelPrice(model: PricingModel, purchasePriceJpy: number, jpyPerUsd: number): number | null {
  if (!model) return null
  const params = tieredParams(model, purchasePriceJpy, jpyPerUsd)
  return params ? calcTieredProfit(params).salePriceUsd : null
}

export interface ListingProfit {
  profitUsd: number
  profitJpy: number
  costUsd: number
}

/**
 * 現在のeBay価格・仕入価格・為替から利益額を計算する(ユーザー要望:
 * eBay商品一覧に仕入値と利益額を表示)。モデル未設定時は既定の手数料・送料
 * (DEFAULT_AUTO_PRICING)で概算する。
 */
export function calcListingProfit(
  model: PricingModel,
  priceUsd: number,
  purchasePriceJpy: number,
  jpyPerUsd: number,
): ListingProfit | null {
  if (!(priceUsd > 0) || !(purchasePriceJpy > 0) || !(jpyPerUsd > 0)) return null
  const feeRate = model ? model.ebayFeeRate + model.adRate + model.customsRate + model.discountRate : DEFAULT_AUTO_PRICING.ebayFeeRate
  const shippingJpy = model ? model.shippingJpy : DEFAULT_AUTO_PRICING.shippingCostJpy
  const fixedCostUsd = model ? model.fixedCostUsd : DEFAULT_AUTO_PRICING.fixedCostUsd
  const costUsd = purchasePriceJpy / jpyPerUsd
  const profitUsd = priceUsd * (1 - feeRate) - costUsd - shippingJpy / jpyPerUsd - fixedCostUsd
  return {
    profitUsd: Math.round(profitUsd * 100) / 100,
    profitJpy: Math.round(profitUsd * jpyPerUsd),
    costUsd: Math.round(costUsd * 100) / 100,
  }
}

/**
 * 本番で確認した不具合(2026-09-22): 価格追従が「保存されている段階利益設定」で
 * 毎回再計算していたため、ユーザーが価格一括編集で別のプリセット(例: 提案B)や
 * 手動調整で付けた価格が、翌日の在庫管理で提案Aの価格に書き換えられた。
 *
 * 追従の意図は「仕入価格・為替が動いた分だけ動かす」なので、現在のeBay価格から
 * 出品時の利益額(円)を逆算し、その利益額を維持したまま新しい仕入価格・為替で
 * 価格を再計算する(手数料・送料等はユーザーの価格モデルの値を使う)。
 * 利益額を逆算できない(価格・仕入価格・出品時レートのいずれかが無い、または
 * 逆算した利益が0以下)場合は null を返し、呼び出し側で段階利益の再計算にフォールバックする。
 */
export function calcPriceKeepingProfit(
  model: PricingModel,
  currentPriceUsd: number,
  oldPurchasePriceJpy: number,
  oldJpyPerUsd: number,
  newPurchasePriceJpy: number,
  newJpyPerUsd: number,
): number | null {
  if (!model) return null
  if (!(currentPriceUsd > 0) || !(oldPurchasePriceJpy > 0) || !(oldJpyPerUsd > 0) || !(newPurchasePriceJpy > 0) || !(newJpyPerUsd > 0)) return null
  const current = calcListingProfit(model, currentPriceUsd, oldPurchasePriceJpy, oldJpyPerUsd)
  if (!current) return null
  const params = {
    purchasePriceJpy: newPurchasePriceJpy,
    profitJpy: current.profitJpy,
    jpyPerUsd: newJpyPerUsd,
    ebayFeeRate: model.ebayFeeRate,
    shippingUsd: model.shippingJpy / newJpyPerUsd,
    fixedCostUsd: model.fixedCostUsd,
    adRate: model.adRate,
    customsRate: model.customsRate,
    discountRate: model.discountRate,
  }
  // 利益がマイナス(赤字)でも「変動分だけ動かす」は成り立つので、価格が正になる限り返す
  const validationError = validateTieredProfitParams(params)
  if (validationError && current.profitJpy > 0) return null
  const price = calcTieredProfit(params).salePriceUsd
  return Number.isFinite(price) && price > 0 ? price : null
}
