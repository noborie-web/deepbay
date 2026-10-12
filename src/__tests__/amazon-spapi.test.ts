import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AmazonAuthError, fetchAccessToken, isAsin, parseAsinInput, MARKETPLACE_JP } from '@/lib/amazon-spapi'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
// Amazonはbot対策が強くスクレイピングが安定しないため、SP-APIを使う。
describe('ASINの読み取り', () => {
  it('改行・カンマ・タブ区切りを受け付ける', () => {
    const { asins } = parseAsinInput('B0F18J2CJF\nB00ABCDEFG,B01ZZZZZZZ\tB07QQQQQQQ')
    expect(asins).toEqual(['B0F18J2CJF', 'B00ABCDEFG', 'B01ZZZZZZZ', 'B07QQQQQQQ'])
  })

  it('重複を取り除く（既存ツールでは入力の39%が重複だった）', () => {
    const { asins } = parseAsinInput('B0F18J2CJF\nB0F18J2CJF\nb0f18j2cjf')
    expect(asins).toEqual(['B0F18J2CJF'])
  })

  it('商品URLからASINを取り出す', () => {
    const { asins } = parseAsinInput([
      'https://www.amazon.co.jp/dp/B0F18J2CJF',
      'https://www.amazon.co.jp/gp/product/B00ABCDEFG?th=1',
    ].join('\n'))
    expect(asins).toEqual(['B0F18J2CJF', 'B00ABCDEFG'])
  })

  it('CSVのヘッダー行(asin)は無視する', () => {
    const { asins, invalid } = parseAsinInput('asin\nB0F18J2CJF')
    expect(asins).toEqual(['B0F18J2CJF'])
    expect(invalid).toEqual([])
  })

  it('ASINでないものは不正として返す（取り違えに気づけるように）', () => {
    const { asins, invalid } = parseAsinInput('B0F18J2CJF\nこれは商品名\n12345')
    expect(asins).toEqual(['B0F18J2CJF'])
    expect(invalid).toEqual(['これは商品名', '12345'])
  })

  it('ASINは10桁の英数字', () => {
    expect(isAsin('B0F18J2CJF')).toBe(true)
    expect(isAsin('B0F18J2CJ')).toBe(false)
    expect(isAsin('B0F18J2CJFX')).toBe(false)
  })
})

describe('LWAのアクセストークン取得', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('日本のマーケットプレイスIDを持っている', () => {
    expect(MARKETPLACE_JP).toBe('A1VC38T7YXB528')
  })

  it('成功したらアクセストークンを返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'Atza|token', expires_in: 3600 }),
    })))

    const result = await fetchAccessToken({ clientId: 'id', clientSecret: 'secret', refreshToken: 'Atzr|r' })
    expect(result.accessToken).toBe('Atza|token')
  })

  it('Amazonが返した理由をそのまま伝える（原因が分かるように）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'The request has an invalid grant parameter.' }),
    })))

    await expect(fetchAccessToken({ clientId: 'id', clientSecret: 'secret', refreshToken: 'bad' }))
      .rejects.toThrow(/invalid grant parameter/)
  })

  it('通信エラーも認証エラーとして扱う', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    await expect(fetchAccessToken({ clientId: 'id', clientSecret: 's', refreshToken: 'r' }))
      .rejects.toBeInstanceOf(AmazonAuthError)
  })
})
