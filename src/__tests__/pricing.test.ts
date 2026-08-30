import { describe, it, expect } from 'vitest'
import {
  calcProfit,
  calcTieredProfit,
  findTierProfitJpy,
  isSafePriceUsd,
  PRODUCT_WRITE_WHITELIST,
  validateProductFields,
  validateProfitParams,
  validateProfitTiers,
  validateTieredProfitParams,
} from '../lib/pricing'
import {
  mergeItemSpecifics,
  parseSpecificValues,
} from '../components/extraction/ItemSpecificsEditModal'
import { applyOp } from '../components/extraction/TitleEditModal'
import { applyDescriptionOp, DESCRIPTION_MAX_LENGTH } from '../components/extraction/DescriptionEditModal'
import { limitImages } from '../components/extraction/ImageCountEditModal'

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

  // 価格一括編集に広告プロモーション率・関税率・ディスカウント率を追加。
  // いずれもeBay手数料率と同様、販売価格から差し引かれるコストとして
  // 分母に合算される。
  it('広告プロモーション率・関税率・ディスカウント率を指定すると、その分だけ販売価格が高くなる', () => {
    const params = { ...BASE_PARAMS, shippingUsd: 0, fixedCostUsd: 0 }
    const withoutExtra = calcProfit(params)
    const withExtra = calcProfit({ ...params, adRate: 0.05, customsRate: 0.03, discountRate: 0.02 })
    expect(withExtra.salePriceUsd).toBeGreaterThan(withoutExtra.salePriceUsd)

    const expected = Math.ceil(withoutExtra.costUsd / (1 - 0.133 - 0.2 - 0.05 - 0.03 - 0.02))
    expect(withExtra.salePriceUsd).toBe(expected)
  })

  it('広告プロモーション率・関税率・ディスカウント率は未指定(省略)なら0として扱う(既存呼び出し元との後方互換)', () => {
    const params = { ...BASE_PARAMS, shippingUsd: 0, fixedCostUsd: 0 }
    expect(calcProfit(params)).toEqual(calcProfit({ ...params, adRate: 0, customsRate: 0, discountRate: 0 }))
  })

  it('利益額は広告プロモーション率・関税率・ディスカウント率を差し引いた後の実際の手取りを反映する', () => {
    const params = { ...BASE_PARAMS, shippingUsd: 0, fixedCostUsd: 0, adRate: 0.05, customsRate: 0.03, discountRate: 0.02 }
    const { salePriceUsd, costUsd, profitUsd } = calcProfit(params)
    const expectedProfit = salePriceUsd * (1 - 0.133 - 0.05 - 0.03 - 0.02) - costUsd
    expect(profitUsd).toBeCloseTo(expectedProfit, 6)
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

  it('手数料率 + 利益率 + 広告プロモーション率 + 関税率 + ディスカウント率 >= 100% の場合はエラー', () => {
    expect(validateProfitParams({
      ...BASE_PARAMS,
      ebayFeeRate: 0.3,
      targetProfitRate: 0.3,
      adRate: 0.2,
      customsRate: 0.1,
      discountRate: 0.1,
    })).not.toBeNull()
  })

  it('広告プロモーション率・関税率・ディスカウント率が負の場合はエラー', () => {
    expect(validateProfitParams({ ...BASE_PARAMS, adRate: -0.1 })).not.toBeNull()
    expect(validateProfitParams({ ...BASE_PARAMS, customsRate: -0.1 })).not.toBeNull()
    expect(validateProfitParams({ ...BASE_PARAMS, discountRate: -0.1 })).not.toBeNull()
  })
})

describe('価格帯別利益額', () => {
  const tiers = [
    { maxPurchaseJpy: 5000, profitJpy: 2000 },
    { maxPurchaseJpy: 10000, profitJpy: 3000 },
    { maxPurchaseJpy: null, profitJpy: 5000 },
  ]

  it('仕入価格の境界を含めて該当する利益額を返す', () => {
    expect(findTierProfitJpy(5000, tiers)).toBe(2000)
    expect(findTierProfitJpy(5001, tiers)).toBe(3000)
    expect(findTierProfitJpy(10000, tiers)).toBe(3000)
    expect(findTierProfitJpy(10001, tiers)).toBe(5000)
  })

  it('価格帯は昇順かつ最後が上限なしの場合に有効', () => {
    expect(validateProfitTiers(tiers)).toBeNull()
    expect(validateProfitTiers([
      { maxPurchaseJpy: 10000, profitJpy: 3000 },
      { maxPurchaseJpy: 5000, profitJpy: 2000 },
      { maxPurchaseJpy: null, profitJpy: 5000 },
    ])).not.toBeNull()
    expect(validateProfitTiers([
      { maxPurchaseJpy: 5000, profitJpy: 2000 },
      { maxPurchaseJpy: 10000, profitJpy: 3000 },
    ])).not.toBeNull()
  })

  it('負の利益額と不正な手数料率を拒否する', () => {
    expect(validateProfitTiers([
      { maxPurchaseJpy: null, profitJpy: -1 },
    ])).not.toBeNull()
    expect(validateTieredProfitParams({
      purchasePriceJpy: 5000,
      profitJpy: 2000,
      jpyPerUsd: 150,
      ebayFeeRate: 1,
      shippingUsd: 15,
      fixedCostUsd: 0,
    })).not.toBeNull()
  })

  it('手数料・送料控除後に設定した利益額以上が残る販売価格を計算する', () => {
    const params = {
      purchasePriceJpy: 5000,
      profitJpy: 2000,
      jpyPerUsd: 150,
      ebayFeeRate: 0.133,
      shippingUsd: 15,
      fixedCostUsd: 0,
    }
    const result = calcTieredProfit(params)
    expect(result.salePriceUsd).toBe(72)
    expect(result.profitUsd).toBeGreaterThanOrEqual(2000 / 150)
    expect(result.profitUsd).toBeLessThan(2000 / 150 + 1)
  })

  it('広告プロモーション率・関税率・ディスカウント率を指定すると、その分だけ販売価格が高くなる', () => {
    const params = {
      purchasePriceJpy: 5000,
      profitJpy: 2000,
      jpyPerUsd: 150,
      ebayFeeRate: 0.133,
      shippingUsd: 15,
      fixedCostUsd: 0,
    }
    const withoutExtra = calcTieredProfit(params)
    const withExtra = calcTieredProfit({ ...params, adRate: 0.05, customsRate: 0.03, discountRate: 0.02 })
    expect(withExtra.salePriceUsd).toBeGreaterThan(withoutExtra.salePriceUsd)
  })

  it('手数料率 + 広告プロモーション率 + 関税率 + ディスカウント率 >= 100% の場合はエラー', () => {
    expect(validateTieredProfitParams({
      purchasePriceJpy: 5000,
      profitJpy: 2000,
      jpyPerUsd: 150,
      ebayFeeRate: 0.5,
      shippingUsd: 15,
      fixedCostUsd: 0,
      adRate: 0.3,
      customsRate: 0.1,
      discountRate: 0.1,
    })).not.toBeNull()
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

  it('65文字のebay_brandは許可される', () => {
    expect(validateProductFields({ ebay_brand: 'a'.repeat(65) })).toBeNull()
  })

  it('66文字のebay_brandは拒否される', () => {
    expect(validateProductFields({ ebay_brand: 'a'.repeat(66) })).not.toBeNull()
  })

  it('空白だけのebay_brandは拒否される', () => {
    expect(validateProductFields({ ebay_brand: '   ' })).not.toBeNull()
  })

  it('nullのebay_brandは許可される（ブランドクリア）', () => {
    expect(validateProductFields({ ebay_brand: null })).toBeNull()
  })

  it('有効なebay_descriptionは許可される', () => {
    expect(validateProductFields({ ebay_description: 'Product description' })).toBeNull()
  })

  it('nullのebay_descriptionは許可される（商品詳細クリア）', () => {
    expect(validateProductFields({ ebay_description: null })).toBeNull()
  })

  it('空白だけのebay_descriptionは拒否される', () => {
    expect(validateProductFields({ ebay_description: '   ' })).not.toBeNull()
  })

  it('500001文字のebay_descriptionは拒否される', () => {
    expect(validateProductFields({ ebay_description: 'a'.repeat(DESCRIPTION_MAX_LENGTH + 1) })).not.toBeNull()
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

  it('ebay_descriptionはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_description')).toBe(true)
  })

  it('ebay_imagesはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_images')).toBe(true)
  })

  it('ebay_category_idはPhase2まで含まれない', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_category_id')).toBe(false)
  })

  it('ebay_titleはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_title')).toBe(true)
  })

  it('ebay_priceはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_price')).toBe(true)
  })

  it('ebay_brandはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_brand')).toBe(true)
  })

  it('purchase_price_jpyはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('purchase_price_jpy')).toBe(true)
  })

  it('ebay_item_specificsはホワイトリストに含まれる', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_item_specifics')).toBe(true)
  })
})

describe('商品詳細一括編集', () => {
  it('同じ商品詳細に置き換える', () => {
    expect(applyDescriptionOp('before', { mode: 'set', value: 'after' })).toBe('after')
  })

  it('先頭・末尾へ追加する', () => {
    expect(applyDescriptionOp('body', { mode: 'add', prefix: '[START]', suffix: '[END]' }))
      .toBe('[START]body[END]')
  })

  it('該当文字列をすべて置換する', () => {
    expect(applyDescriptionOp('Japan / Japan', { mode: 'replace', searchStr: 'Japan', replaceStr: 'JP' }))
      .toBe('JP / JP')
  })

  it('クリア時はnullを返す', () => {
    expect(applyDescriptionOp('body', { mode: 'clear' })).toBeNull()
  })

  it('最大文字数を超えない', () => {
    const result = applyDescriptionOp('', { mode: 'set', value: 'a'.repeat(DESCRIPTION_MAX_LENGTH + 10) })
    expect(result).toHaveLength(DESCRIPTION_MAX_LENGTH)
  })
})

describe('画像枚数一括編集', () => {
  const images = Array.from({ length: 15 }, (_, index) => `https://example.com/${index + 1}.jpg`)

  it('指定した先頭枚数だけを残す', () => {
    expect(limitImages(images, 3)).toEqual(images.slice(0, 3))
  })

  it('上限は12枚', () => {
    expect(limitImages(images, 99)).toEqual(images.slice(0, 12))
  })

  it('最低1枚を残す', () => {
    expect(limitImages(images, 0)).toEqual(images.slice(0, 1))
  })

  it('有効な画像URL配列を許可する', () => {
    expect(validateProductFields({ ebay_images: images.slice(0, 12) })).toBeNull()
  })

  it('13枚以上を拒否する', () => {
    expect(validateProductFields({ ebay_images: images.slice(0, 13) })).toMatch(/最大12件/)
  })

  it('HTTP(S)以外のURLを拒否する', () => {
    expect(validateProductFields({ ebay_images: ['javascript:alert(1)'] })).toMatch(/HTTP\(S\)/)
  })
})

describe('アイテムスペシフィック編集', () => {
  it('カンマ・読点・改行で値を分割し、重複を除く', () => {
    expect(parseSpecificValues('Plastic, Metal、Plastic\nWood'))
      .toEqual(['Plastic', 'Metal', 'Wood'])
  })

  it('既存項目を保持し、同名項目を上書きする', () => {
    expect(mergeItemSpecifics(
      { Brand: ['Tamiya'], Material: ['Metal'] },
      { Material: ['Plastic'], Color: ['Red'] },
    )).toEqual({
      Brand: ['Tamiya'],
      Material: ['Plastic'],
      Color: ['Red'],
    })
  })

  it('正しいオブジェクトを許可する', () => {
    expect(validateProductFields({
      ebay_item_specifics: {
        Brand: ['Tamiya'],
        Material: ['Plastic', 'Metal'],
      },
    })).toBeNull()
  })

  it('配列やnullを拒否する', () => {
    expect(validateProductFields({ ebay_item_specifics: [] })).not.toBeNull()
    expect(validateProductFields({ ebay_item_specifics: null })).not.toBeNull()
  })

  it('空の値配列を拒否する', () => {
    expect(validateProductFields({ ebay_item_specifics: { Brand: [] } })).not.toBeNull()
  })

  it('50項目を超えるデータを拒否する', () => {
    const specifics = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`Field${index}`, ['Value']]),
    )
    expect(validateProductFields({ ebay_item_specifics: specifics })).toMatch(/最大50項目/)
  })

  it('65文字を超える項目名・値を拒否する', () => {
    expect(validateProductFields({
      ebay_item_specifics: { ['a'.repeat(66)]: ['Value'] },
    })).not.toBeNull()
    expect(validateProductFields({
      ebay_item_specifics: { Brand: ['a'.repeat(66)] },
    })).not.toBeNull()
  })
})
