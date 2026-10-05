import { describe, expect, it } from 'vitest'
import { EBAY_CONDITION_OPTIONS, MEDIA_CONDITION_MAP, conditionIdForProduct } from '@/lib/listing-export'
import { ALLOWED_CONDITION_IDS, PRODUCT_WRITE_WHITELIST, validateProductFields } from '@/lib/pricing'
import type { Product } from '@/types/database'

function product(overrides: Partial<Product>): Product {
  return { ebay_condition: null, original_condition: null, ebay_condition_id: null, ...overrides } as Product
}

// ユーザー要望(2026-10-05): 商品編集画面でConditionIDを直接・一括で指定したい
// (2750 / Like New、4000 / Very Good、5000 / Good など)。
describe('ConditionIDの直接指定', () => {
  it('指定があれば商品状態より優先される', () => {
    expect(conditionIdForProduct(product({ ebay_condition: '中古', ebay_condition_id: '2750' }))).toBe('2750')
    expect(conditionIdForProduct(product({ original_condition: '傷や汚れあり', ebay_condition_id: '5000' }))).toBe('5000')
  })

  it('カテゴリ別マッピングよりも優先される', () => {
    expect(
      conditionIdForProduct(product({ ebay_condition: '中古', ebay_condition_id: '4000' }), '176984', MEDIA_CONDITION_MAP),
    ).toBe('4000')
  })

  it('未指定(null)なら従来どおり商品状態から判定する', () => {
    expect(conditionIdForProduct(product({ ebay_condition: '中古' }))).toBe('3000')
    expect(conditionIdForProduct(product({ ebay_condition: '中古' }), '176984', MEDIA_CONDITION_MAP)).toBe('5000')
  })
})

describe('ConditionIDの保存と検証', () => {
  it('保存できるフィールドとして許可されている', () => {
    expect(PRODUCT_WRITE_WHITELIST.has('ebay_condition_id')).toBe(true)
  })

  it('有効なIDとnull(自動に戻す)は通る', () => {
    expect(validateProductFields({ ebay_condition_id: '2750' })).toBeNull()
    expect(validateProductFields({ ebay_condition_id: null })).toBeNull()
  })

  it('一覧にないIDや数値は拒否する', () => {
    expect(validateProductFields({ ebay_condition_id: '9999' })).toContain('ebay_condition_id')
    expect(validateProductFields({ ebay_condition_id: 3000 })).toContain('ebay_condition_id')
  })

  // 検証用のIDリスト(pricing)と画面の選択肢(listing-export)が食い違うと、
  // 画面で選べるのに保存でエラーになる。
  it('検証用のIDリストと画面の選択肢が一致している', () => {
    expect([...ALLOWED_CONDITION_IDS].sort()).toEqual(EBAY_CONDITION_OPTIONS.map((o) => o.id).sort())
  })
})
