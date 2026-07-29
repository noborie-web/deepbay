import { describe, expect, it } from 'vitest'
import {
  matchesDangerSeller,
  normalizeSellerUrl,
  sellerIdFromUrl,
} from '@/lib/danger-seller'

describe('danger seller matching', () => {
  it('セラーURLのクエリと末尾スラッシュを除いて正規化する', () => {
    expect(normalizeSellerUrl(
      'https://JP.MERCARI.COM/user/profile/123/?tracking=1',
    )).toBe('https://jp.mercari.com/user/profile/123')
  })

  it('/user/profile と /s からセラーIDを取得する', () => {
    expect(sellerIdFromUrl('https://jp.mercari.com/user/profile/123')).toBe('123')
    expect(sellerIdFromUrl('https://jp.mercari.com/s/ABC')).toBe('abc')
  })

  it('商品セラーIDと登録済みプロフィールURLを照合する', () => {
    expect(matchesDangerSeller(
      { sellerId: '123' },
      ['https://jp.mercari.com/user/profile/123'],
    )).toBe(true)
  })

  it('異なる形式のセラーURLでも同じIDなら照合する', () => {
    expect(matchesDangerSeller(
      { sellerUrl: 'https://jp.mercari.com/s/ABC' },
      ['https://jp.mercari.com/user/profile/abc?ref=search'],
    )).toBe(true)
  })

  it('別セラーやセラー情報がない商品には一致しない', () => {
    const registered = ['https://jp.mercari.com/user/profile/123']
    expect(matchesDangerSeller({ sellerId: '456' }, registered)).toBe(false)
    expect(matchesDangerSeller({}, registered)).toBe(false)
  })
})
