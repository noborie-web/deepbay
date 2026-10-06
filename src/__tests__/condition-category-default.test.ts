import { describe, expect, it, vi } from 'vitest'
import { MEDIA_CONDITION_MAP, conditionIdForProduct } from '@/lib/listing-export'
import type { Product } from '@/types/database'

function product(overrides: Partial<Product>): Product {
  return { ebay_condition: null, original_condition: null, ebay_condition_id: null, ...overrides } as Product
}

// ユーザー要望(2026-10-06): 本番のCDs下書き819件のうち70件は、商品状態が空
// (69件)か、説明文が連結した壊れた文字列(1件)で、変換表にキーが無いため
// 既定の 3000 (Used) に落ちていた。CDは3000を受け付けないため出品が失敗する。
describe('カテゴリごとの既定ConditionID', () => {
  it('商品状態が空のときに使われる', () => {
    expect(conditionIdForProduct(product({}), '176984', MEDIA_CONDITION_MAP, '5000')).toBe('5000')
  })

  it('変換表にない文字列のときに使われる', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = '目立った傷や汚れなし細かな使用感・傷・汚れはあるが、目立たない'
    expect(conditionIdForProduct(product({ original_condition: broken }), '176984', MEDIA_CONDITION_MAP, '5000')).toBe('5000')
  })

  it('変換表にある状態には影響しない', () => {
    expect(conditionIdForProduct(product({ ebay_condition: '中古' }), '176984', MEDIA_CONDITION_MAP, '6000')).toBe('5000')
    expect(conditionIdForProduct(product({ original_condition: '未使用' }), '176984', MEDIA_CONDITION_MAP, '6000')).toBe('2750')
  })

  it('商品ごとのConditionID指定の方が優先される', () => {
    expect(conditionIdForProduct(product({ ebay_condition_id: '4000' }), '176984', MEDIA_CONDITION_MAP, '5000')).toBe('4000')
  })

  it('未設定なら従来どおり 3000 に落ちる', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(conditionIdForProduct(product({}), '176984', MEDIA_CONDITION_MAP)).toBe('3000')
    expect(conditionIdForProduct(product({}), '176984', MEDIA_CONDITION_MAP, null)).toBe('3000')
  })
})
