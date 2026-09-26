import { describe, expect, it } from 'vitest'
import { decideSiteRevisePrice } from '@/lib/inventory-site-pricing'

// ユーザー要望(2026-09-25): UK/AUの価格追従。維持している利益額(円)を各サイトの
// 通貨に換算して反映する。「赤字になるのは絶対に避けて」という方針どおり、
// 計算できない・不自然に大きく下がる場合は送らない。
describe('UK/AU出品の価格追従', () => {
  it('US出品はUSD価格をそのまま使う', () => {
    expect(decideSiteRevisePrice({
      currentPrice: 100, usdPrice: 110, jpyPerUsd: 157, siteId: 'US', jpyPerCurrency: 157,
    })).toEqual({ action: 'revise', price: 110, currency: 'USD' })
  })

  it('UK出品は円価値を保ったままGBPへ換算する', () => {
    // 110USD × 157円 = 17,270円 → ÷ 210円/GBP = 82.24GBP
    expect(decideSiteRevisePrice({
      currentPrice: 80, usdPrice: 110, jpyPerUsd: 157, siteId: 'UK', jpyPerCurrency: 210,
    })).toEqual({ action: 'revise', price: 82.24, currency: 'GBP' })
  })

  it('AU出品はAUDへ換算する', () => {
    // 110USD × 157円 = 17,270円 → ÷ 111.53円/AUD = 154.85AUD
    const result = decideSiteRevisePrice({
      currentPrice: 140, usdPrice: 110, jpyPerUsd: 157, siteId: 'AU', jpyPerCurrency: 111.53,
    })
    expect(result).toMatchObject({ action: 'revise', currency: 'AUD' })
    expect((result as { price: number }).price).toBeCloseTo(154.85, 2)
  })

  it('numeric列が文字列で返っても数値として扱う', () => {
    expect(decideSiteRevisePrice({
      currentPrice: '80' as unknown as number, usdPrice: '110' as unknown as number,
      jpyPerUsd: '157' as unknown as number, siteId: 'UK', jpyPerCurrency: 210,
    })).toEqual({ action: 'revise', price: 82.24, currency: 'GBP' })
  })

  it('差が0.5以下なら送らない', () => {
    expect(decideSiteRevisePrice({
      currentPrice: 82, usdPrice: 110, jpyPerUsd: 157, siteId: 'UK', jpyPerCurrency: 210,
    })).toEqual({ action: 'skip', reason: 'unchanged' })
  })

  it('15%を超える値下げになる計算結果は適用しない(通貨取り違え・レート異常の安全網)', () => {
    // GBPのつもりがUSDのレートで計算してしまったようなケース
    expect(decideSiteRevisePrice({
      currentPrice: 120, usdPrice: 110, jpyPerUsd: 157, siteId: 'UK', jpyPerCurrency: 400,
    })).toEqual({ action: 'skip', reason: 'guarded' })
  })

  it('レートやUSD価格が無ければ送らない', () => {
    expect(decideSiteRevisePrice({
      currentPrice: 80, usdPrice: 110, jpyPerUsd: null, siteId: 'UK', jpyPerCurrency: 210,
    })).toEqual({ action: 'skip', reason: 'no_rate' })
    expect(decideSiteRevisePrice({
      currentPrice: 80, usdPrice: null, jpyPerUsd: 157, siteId: 'UK', jpyPerCurrency: 210,
    })).toEqual({ action: 'skip', reason: 'no_price' })
  })
})

// ユーザー要望(2026-09-26): 関税率は米国向けの設定なので、UK/AU出品では
// 適用しない。価格追従もCSV出力と同じ補正を使う(食い違わせない)。
describe('US以外で関税率を適用しない設定（価格追従）', () => {
  it('補正率を渡すとUK価格がその分だけ安くなる(£82.24 → £68.18)', () => {
    const result = decideSiteRevisePrice({
      currentPrice: 80, usdPrice: 110, jpyPerUsd: 157, siteId: 'UK',
      jpyPerCurrency: 210, priceAdjustment: 0.63 / 0.76,
    })
    expect(result).toEqual({ action: 'revise', price: 68.18, currency: 'GBP' })
  })

  it('補正後の価格が15%超の値下げになる場合は安全網が効く', () => {
    const result = decideSiteRevisePrice({
      currentPrice: 85, usdPrice: 110, jpyPerUsd: 157, siteId: 'UK',
      jpyPerCurrency: 210, priceAdjustment: 0.63 / 0.76,
    })
    expect(result).toEqual({ action: 'skip', reason: 'guarded' })
  })

  it('US出品には補正をかけない', () => {
    expect(decideSiteRevisePrice({
      currentPrice: 100, usdPrice: 110, jpyPerUsd: 157, siteId: 'US',
      jpyPerCurrency: 157, priceAdjustment: 0.63 / 0.76,
    })).toEqual({ action: 'revise', price: 110, currency: 'USD' })
  })
})
