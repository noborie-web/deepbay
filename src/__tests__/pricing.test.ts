import { describe, it, expect } from 'vitest'
import { calcProfit, validateProfitParams, isSafePriceUsd, validateProductFields, PRODUCT_WRITE_WHITELIST } from '../lib/pricing'
import { applyOp } from '../components/extraction/TitleEditModal'

const BASE_PARAMS = {
  purchasePriceJpy: 5000,
  jpyPerUsd: 150,
  ebayFeeRate: 0.133,
  targetProfitRate: 0.2,
  shippingUsd: 15,
  fixedCostUsd: 0,
}

describe('価格変換: 円がそのままドルにならない', () => {
  it('5000円/150 + 送料・利益計算した結果が $5000 ではない', () => {
    const { salePriceUsd } = calcProfit(BASE_PARAMS)
    expect(salePriceUsd).toBeLessThan(500)
    expect(salePriceUsd).toBeGreaterThan(0)
  })

  it('5000円は約33USD相当のコストになる (150JPY/USD)', () => {
    const { costUsd } = calcProfit(BASE_PARAMS)
    expect(costUsd).toBeCloseTo(5000 / 150, 2)
  })
})

describe('利益計算式', () => {
  it('手数料・利益率を正しく反映する', () => {
    const params = { ...BASE_PARAMS, shippingUsd: 0, fixedCostUsd: 0 }
    const { salePriceUsd, costUsd } = calcProfit(params)
    const expected = Math.ceil(costUsd / (1 - 0.133 - 0.2))
    expect(salePriceUsd).toBe(expected)
  })

  it('利益が正の値になる', () => {
    const { profitUsd } = calcProfit(BASE_PARAMS)
    expect(profitUsd).toBeGreaterThan(0)
  })

  it('端数処理: Math.ceil で1ドル単位切り上げ', () => {
    const params = { ...BASE_PARAMS, purchasePriceJpy: 1000, shippingUsd: 0, fixedCostUsd: 0 }
    const { salePriceUsd } = calcProfit(params)
    expect(Number.isInteger(salePriceUsd)).toBe(true)
  })
})

describe('validateProfitParams', () => {
  it('正常な値ではnullを返す', () => {
    expect(validateProfitParams(BASE_PARAMS)).toBeNull()
  })

  it('仕入価格が0の場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, purchasePriceJpy: 0 })).not.toBeNull()
  })

  it('仕入価格が負の場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, purchasePriceJpy: -1 })).not.toBeNull()
  })

  it('仕入価格がNaNの場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, purchasePriceJpy: NaN })).not.toBeNull()
  })

  it('為替レートが0の場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, jpyPerUsd: 0 })).not.toBeNull()
  })

  it('為替レートが負の場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, jpyPerUsd: -1 })).not.toBeNull()
  })

  it('為替レートがNaNの場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, jpyPerUsd: NaN })).not.toBeNull()
  })

  it('手数料率 + 利益率 = 100% の場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, ebayFeeRate: 0.5, targetProfitRate: 0.5 })).not.toBeNull()
  })

  it('手数料率 + 利益率 > 100% の場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, ebayFeeRate: 0.6, targetProfitRate: 0.5 })).not.toBeNull()
  })
})

describe('validateProductFields', () => {
  it('81文字のebay_titleは拒否される', () => {
    expect(validateProductFields({ ebay_title: 'a'.repeat(81) })).not.toBeNull()
  })

  it('80文字のebay_titleは許可される', () => {
    expect(validateProductFields({ ebay_title: 'a'.repeat(80) })).toBeNull()
  })

  it('空のebay_titleは拒否される', () => {
    expect(validateProductFields({ ebay_title: '' })).not.toBeNull()
  })

  it('負数のebay_priceは拒否される', () => {
    expect(validateProductFields({ ebay_price: -1 })).not.toBeNull()
  })

  it('NaNのebay_priceは拒否される', () => {
    expect(validateProductFields({ ebay_price: NaN })).not.toBeNull()
  })

  it('Infinityのebay_priceは拒否される', () => {
    expect(validateProductFields({ ebay_price: Infinity })).not.toBeNull()
  })

  it('nullのebay_priceは許可される', () => {
    expect(validateProductFields({ ebay_price: null })).toBeNull()
  })

  it('不正なebay_conditionは拒否される', () => {
    expect(validateProductFields({ ebay_condition: 'excellent' })).not.toBeNull()
  })

  it('正しいebay_conditionは許可される', () => {
    expect(validateProductFields({ ebay_condition: '新品' })).toBeNull()
  })
})

describe('isSafePriceUsd', () => {
  it('正の有限数はtrue', () => expect(isSafePriceUsd(50)).toBe(true))
  it('0はfalse', () => expect(isSafePriceUsd(0)).toBe(false))
  it('負数はfalse', () => expect(isSafePriceUsd(-1)).toBe(false))
  it('Infinityはfalse', () => expect(isSafePriceUsd(Infinity)).toBe(false))
  it('NaNはfalse', () => expect(isSafePriceUsd(NaN)).toBe(false))
})

describe('タイトル80文字制限', () => {
  it('80文字を超えるタイトルは常に80文字以内に切り詰める', () => {
    const title = 'a'.repeat(100)
    const result = applyOp(title, {})
    expect(result.length).toBeLessThanOrEqual(80)
  })

  it('prefix追加後も80文字以内になる', () => {
    const title = 'a'.repeat(79)
    const result = applyOp(title, { prefix: 'PREFIX_' })
    expect(result.length).toBeLessThanOrEqual(80)
  })

  it('80文字以内のタイトルはそのまま', () => {
    const title = 'a'.repeat(50)
    const result = applyOp(title, {})
    expect(result.length).toBe(50)
  })
})

describe('一括タイトル編集: prefix/suffix/置換', () => {
  it('prefix追加', () => {
    expect(applyOp('hello', { prefix: '[JP] ' })).toBe('[JP] hello')
  })

  it('suffix追加', () => {
    expect(applyOp('hello', { suffix: ' from Japan' })).toBe('hello from Japan')
  })

  it('検索・置換', () => {
    expect(applyOp('hello world', { searchStr: 'world', replaceStr: 'Japan' })).toBe('hello Japan')
  })

  it('置換後文字列が空の場合は削除', () => {
    expect(applyOp('hello world', { searchStr: ' world', replaceStr: '' })).toBe('hello')
  })

  it('prefix + suffix + 80文字制限', () => {
    const title = 'a'.repeat(70)
    const result = applyOp(title, { prefix: 'PREFIX_', suffix: '_SUFFIX' })
    expect(result.length).toBeLessThanOrEqual(80)
  })
})

describe('ホワイトリスト: 許可されていないフィールドを拒否', () => {
  it('original_priceはホワイトリストに含まれない', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('original_price')).toBe(false)
  })

  it('user_idはホワイトリストに含まれない', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('user_id')).toBe(false)
  })

  it('listing_statusはホワイトリストに含まれない', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('listing_status')).toBe(false)
  })

  it('extraction_idはホワイトリストに含まれない', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('extraction_id')).toBe(false)
  })

  it('ebay_titleはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_title')).toBe(true)
  })

  it('ebay_priceはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_price')).toBe(true)
  })

  it('purchase_price_jpyはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('purchase_price_jpy')).toBe(true)
  })
})
