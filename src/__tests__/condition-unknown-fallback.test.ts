import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONDITION_GRADES,
  MEDIA_CONDITION_MAP,
  STANDARD_CONDITION_MAP,
  conditionIdForProduct,
  warnUnknownCondition,
} from '@/lib/listing-export'
import type { Product } from '@/types/database'

function product(overrides: Partial<Product>): Product {
  return { ebay_condition: null, original_condition: null, ...overrides } as Product
}

// 本番データで確認(2026-10-05): Yahoo!フリマ由来の「未使用」が101件あり、
// 対応表に無いため既定の 3000 (Used) に落ちていた。新品が中古として出品され、
// CD等のカテゴリではアップロード自体が失敗する。
describe('Yahoo!フリマの「未使用」', () => {
  it('新品として扱う(1000 / New)', () => {
    expect(conditionIdForProduct(product({ original_condition: '未使用' }))).toBe('1000')
    expect(conditionIdForProduct(product({ ebay_condition: '未使用' }))).toBe('1000')
  })

  it('メディア系プリセットでは 2750 / Like New(3000ではない)', () => {
    expect(MEDIA_CONDITION_MAP['未使用']).toBe('2750')
    expect(Object.values(MEDIA_CONDITION_MAP)).not.toContain('3000')
  })

  it('標準プリセットにも含まれ、設定画面の項目にも出る', () => {
    expect(STANDARD_CONDITION_MAP['未使用']).toBe('1000')
    expect(CONDITION_GRADES).toContain('未使用')
  })

  it('メルカリの「新品、未使用」は従来どおり 1000', () => {
    expect(conditionIdForProduct(product({ original_condition: '新品、未使用' }))).toBe('1000')
  })
})

describe('対応表に無い商品状態', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('既定の 3000 に落ちることを警告として記録する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const condition = `謎の状態-${Math.random()}`

    expect(conditionIdForProduct(product({ original_condition: condition }))).toBe('3000')
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain(condition)
  })

  it('同じ値で何度も警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const condition = `謎の状態-${Math.random()}`

    warnUnknownCondition(condition)
    warnUnknownCondition(condition)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('既知の状態や未設定では警告しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    conditionIdForProduct(product({ original_condition: '中古' }))
    conditionIdForProduct(product({}))
    expect(warn).not.toHaveBeenCalled()
  })

  it('カテゴリ別設定で割り当て済みなら警告せず、その値を使う', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const condition = `謎の状態-${Math.random()}`

    expect(conditionIdForProduct(product({ original_condition: condition }), '176984', { [condition]: '4000' })).toBe('4000')
    expect(warn).not.toHaveBeenCalled()
  })
})
