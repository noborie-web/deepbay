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
  }
}

export async function loadPricingModel(db: SupabaseClient, userId: string): Promise<PricingModel> {
  try {
    const { data } = await db
      .from('price_tier_settings')
      .select('tiers, ebay_fee_rate, shipping_jpy, fixed_cost_usd, ad_rate, customs_rate, discount_rate')
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
