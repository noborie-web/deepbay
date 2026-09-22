import { describe, expect, it } from 'vitest'
import { calcListingProfit, calcPriceKeepingProfit, calcModelPrice, toPricingModel } from '@/lib/inventory-pricing'

// 本番のユーザー設定(価格一括編集の段階利益方式)。9/13の出品価格が
// この式で計算されていることを実データで確認済み
// (仕入¥17,888 → $297.60 @154.08円、仕入¥47,000 → $649.02 @154.08円)。
const userTierSettings = {
  tiers: [
    { profitJpy: 2000, maxPurchaseJpy: 5000 },
    { profitJpy: 3000, maxPurchaseJpy: 10000 },
    { profitJpy: 5000, maxPurchaseJpy: 20000 },
    { profitJpy: 10000, maxPurchaseJpy: 50000 },
    { profitJpy: 15000, maxPurchaseJpy: null },
  ],
  ebay_fee_rate: '0.15',
  shipping_jpy: 6000,
  fixed_cost_usd: '0',
  ad_rate: '0.04',
  customs_rate: '0.13',
  discount_rate: '0.05',
}

describe('toPricingModel / calcModelPrice', () => {
  it('price_tier_settings の行から価格モデルを作り、手動設定した出品価格を再現する', () => {
    const model = toPricingModel(userTierSettings)
    expect(model?.kind).toBe('tiered')
    // (17888 + 5000 + 6000) / 154.08 / (1 - 0.15 - 0.04 - 0.13 - 0.05)
    expect(calcModelPrice(model, 17888, 154.08)).toBeCloseTo(297.6, 1)
    expect(calcModelPrice(model, 47000, 154.08)).toBeCloseTo(649.02, 1)
  })

  it('仕入価格が上がれば価格帯に応じて出品価格も上がる(赤字にならない)', () => {
    const model = toPricingModel(userTierSettings)
    const before = calcModelPrice(model, 25800, 154.69)!
    const after = calcModelPrice(model, 35800, 154.69)!
    expect(after).toBeGreaterThan(before)
    expect(after - before).toBeGreaterThan(10000 / 154.69)
  })

  it('設定が無ければ null(既存の計算式にフォールバック)', () => {
    expect(toPricingModel(null)).toBeNull()
    expect(toPricingModel({ tiers: [] })).toBeNull()
    expect(calcModelPrice(null, 1000, 150)).toBeNull()
  })
})

describe('calcListingProfit', () => {
  it('現在のeBay価格・仕入値・為替から利益額を計算する', () => {
    const model = toPricingModel(userTierSettings)
    const profit = calcListingProfit(model, 297.6, 17888, 154.08)!
    // 手動設定価格なら目標利益(¥5,000)前後になる
    expect(profit.profitJpy).toBeGreaterThanOrEqual(4990)
    expect(profit.profitJpy).toBeLessThanOrEqual(5010)
    expect(profit.profitUsd).toBeCloseTo(5000 / 154.08, 1)
  })

  it('eBay価格が下がりすぎていれば赤字(マイナス)として返す', () => {
    const model = toPricingModel(userTierSettings)
    const profit = calcListingProfit(model, 150, 17888, 154.08)!
    expect(profit.profitUsd).toBeLessThan(0)
  })

  it('価格・仕入値・為替が無ければ null', () => {
    expect(calcListingProfit(null, 0, 1000, 150)).toBeNull()
    expect(calcListingProfit(null, 100, 0, 150)).toBeNull()
  })

  // 本番で確認した不具合(2026-09-22): 別プリセット(提案B)で付けた価格が、翌日の
  // 追従で保存中の設定(提案A)の価格に書き換えられた。出品時の利益額(円)を維持
  // したまま仕入価格・為替の変動分だけ動かす。
  describe('calcPriceKeepingProfit', () => {
    const model = toPricingModel(userTierSettings)

    it('仕入価格・為替が変わらなければ元の価格をほぼ再現する(利益額を維持)', () => {
      const price = calcPriceKeepingProfit(model, 148.2, 5980, 156.84, 5980, 156.84)!
      expect(price).toBeCloseTo(148.2, 1)
    })

    it('為替だけ動いたら、利益額(円)を維持した価格になる(段階利益の値には戻さない)', () => {
      const price = calcPriceKeepingProfit(model, 148.2, 5980, 156.84, 5980, 157.32)!
      // 利益額を維持: 円建て合計(5980 + 利益 + 6000)は不変なので、価格は 156.84/157.32 倍
      expect(price).toBeCloseTo(148.2 * 156.84 / 157.32, 1)
      // 保存中の段階利益(¥2,200 → $143.08)には戻さない
      expect(price).toBeGreaterThan(146)
    })

    it('仕入価格が上がったら、その分だけ値上げする(利益額は維持)', () => {
      const before = calcListingProfit(model, 148.2, 5980, 156.84)!.profitJpy
      const price = calcPriceKeepingProfit(model, 148.2, 5980, 156.84, 6980, 156.84)!
      const after = calcListingProfit(model, price, 6980, 156.84)!.profitJpy
      expect(after).toBeGreaterThanOrEqual(before - 2)
      expect(after).toBeLessThanOrEqual(before + 2)
      expect(price).toBeGreaterThan(148.2)
    })

    it('赤字の価格でも「変動分だけ動かす」は成り立つ(為替変動分だけスケール)', () => {
      expect(calcPriceKeepingProfit(model, 50, 5980, 156.84, 5980, 157)).toBeCloseTo(50 * 156.84 / 157, 1)
    })

    it('情報不足の場合は null', () => {
      expect(calcPriceKeepingProfit(model, 148.2, 0, 156.84, 5980, 157)).toBeNull()
      expect(calcPriceKeepingProfit(null, 148.2, 5980, 156.84, 5980, 157)).toBeNull()
    })
  })
})
