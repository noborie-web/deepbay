import { describe, expect, it } from 'vitest'
import { marketplaceIdForSite } from '@/lib/ebay-sites'

// ユーザー報告(2026-10-19): UK/AUに出品するセラーで、UK用のポリシーが
// 選択肢に出てこなかった。ビジネスポリシーはマーケットプレイスごとに別物。

describe('marketplaceIdForSite', () => {
  // UK の marketplaceId は EBAY_UK ではなく EBAY_GB。間違えると取得が空になる
  it('UKはEBAY_GBに対応づける', () => {
    expect(marketplaceIdForSite('UK')).toBe('EBAY_GB')
  })

  it('US・AUもそれぞれの marketplaceId になる', () => {
    expect(marketplaceIdForSite('US')).toBe('EBAY_US')
    expect(marketplaceIdForSite('AU')).toBe('EBAY_AU')
  })

  it('eBayの表記(EBAY_GB)からも引ける', () => {
    expect(marketplaceIdForSite('EBAY_GB')).toBe('EBAY_GB')
    expect(marketplaceIdForSite('GB')).toBe('EBAY_GB')
  })

  it('不明な値はUSに倒す', () => {
    expect(marketplaceIdForSite(null)).toBe('EBAY_US')
    expect(marketplaceIdForSite('XX')).toBe('EBAY_US')
  })
})
