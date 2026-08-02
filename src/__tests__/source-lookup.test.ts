import { describe, expect, it } from 'vitest'
import {
  createSourceLookupCode,
  normalizeSourceLookupCode,
  SOURCE_LOOKUP_CODE_PATTERN,
} from '@/lib/source-lookup'

describe('source URL lookup code', () => {
  it('ele_日付_16文字の推測不能なDBK-IDを生成する', () => {
    const code = createSourceLookupCode(new Date('2026-07-27T09:00:00.000Z'))
    expect(code).toMatch(/^ele_20260727_[A-HJ-NP-Z2-9]{16}$/)
    expect(SOURCE_LOOKUP_CODE_PATTERN.test(code)).toBe(true)
  })

  it('連続生成してもDBK-IDが重複しない', () => {
    const codes = new Set(
      Array.from({ length: 500 }, () => createSourceLookupCode()),
    )
    expect(codes.size).toBe(500)
  })

  it('入力されたDBK-IDの前後空白と英字の大小を正規化する', () => {
    expect(normalizeSourceLookupCode(' ele_20260727_a2b3c4d5e6f7g8h9 ')).toBe(
      'ele_20260727_A2B3C4D5E6F7G8H9',
    )
  })

  it('DBK-IDではない文字列は勝手に変換しない', () => {
    expect(normalizeSourceLookupCode('not-a-code')).toBe('not-a-code')
  })
})
