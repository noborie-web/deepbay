import { describe, expect, it } from 'vitest'
import { adjustedJpyRate, type PricingModel } from '@/lib/inventory-pricing'

// 本番で確認した不具合(2026-10-20): 抽出だけレート調整(rate_adjustment_jpy)を
// 適用していなかった。仕入先チェックとCSV出力は adjustedJpyRate を通すため、
// 初回の仕入先チェックで「実際には起きていない為替変動」とみなされ、
// 全商品が約3.3%値上げされていた(US出品1,230件が比率1.033で一致)。
//
// 実データ: 記録レート 153.07 / 調整 5円 → 153.07 / 148.07 = 1.0338

const model = { rateAdjustmentJpy: 5 } as PricingModel

describe('レート調整の一貫性', () => {
  it('USDは調整額を引く（円高方向＝安全側に見積もる）', () => {
    expect(adjustedJpyRate(model, 'USD', 153.07, 153.07)).toBeCloseTo(148.07, 2)
  })

  // 抽出で調整を通さないと、ここが食い違って値上げが発生する
  it('調整あり・なしの比が、観測された値上げ率と一致する', () => {
    const raw = 153.07
    const adjusted = adjustedJpyRate(model, 'USD', raw, raw)
    // 価格は概ねレートに反比例するので、比はそのまま値上げ率になる
    expect(raw / adjusted).toBeCloseTo(1.034, 2)
  })

  it('調整が0なら素のレートのまま（従来設定の利用者に影響しない）', () => {
    const noAdjust = { rateAdjustmentJpy: 0 } as PricingModel
    expect(adjustedJpyRate(noAdjust, 'USD', 153.07, 153.07)).toBe(153.07)
  })

  it('USD以外は比率で調整する', () => {
    expect(adjustedJpyRate(model, 'GBP', 200, 153.07)).toBeCloseTo(200 * (1 - 5 / 153.07), 4)
  })
})
