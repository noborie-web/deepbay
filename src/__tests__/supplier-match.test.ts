import { describe, expect, it, vi } from 'vitest'

// ユーザー要望(事故復旧): 仕入先URLが消えた商品を、元タイトル(30文字で
// 切れている)+仕入価格でメルカリを検索して照合する。
const mocks = vi.hoisted(() => ({ scrapeUrl: vi.fn() }))
vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl, findScraper: vi.fn() }))

import { buildSearchKeywords, findSupplierMatch, normalizeTitle, scoreCandidate, titleSimilarity } from '@/lib/supplier-match'

describe('normalizeTitle / titleSimilarity', () => {
  it('全角・記号・空白の違いを無視して比較する', () => {
    expect(normalizeTitle('【激レア】TWICE　2018 トレカ！')).toBe(normalizeTitle('激レア twice 2018 トレカ'))
  })
  it('切れた元タイトルの前方一致は高く評価する', () => {
    expect(titleSimilarity('【黄シール帯】GREAT PUNK HITS【希少CD】【初', '【黄シール帯】GREAT PUNK HITS【希少CD】【初回盤】')).toBeGreaterThanOrEqual(0.97)
    expect(titleSimilarity('ATEEZ サン キャンパスボード', 'BTS トートバッグ')).toBeLessThan(0.3)
  })
})

describe('scoreCandidate', () => {
  it('タイトルが少し違っても価格が一致すれば加点される', () => {
    const product = { title: '非売品 激レア X JAPAN プロモCD 国内盤', priceJpy: 21111 }
    expect(scoreCandidate(product, { title: '非売品 X JAPAN プロモCD', price: 21111 }))
      .toBeGreaterThan(scoreCandidate(product, { title: '非売品 X JAPAN プロモCD', price: 15555 }))
  })
})

describe('buildSearchKeywords', () => {
  it('装飾語を除き、末尾が切れている語を落とした候補も作る', () => {
    const keywords = buildSearchKeywords('【新品未開封】王の顔　韓国盤　ソ•イングク　　　　　　韓国ド')
    expect(keywords[0]).toBe('王の顔 韓国盤 ソ•イングク 韓国ド')
    expect(keywords).toContain('王の顔 韓国盤 ソ•イングク')
  })
})

describe('findSupplierMatch', () => {
  it('検索0件なら次のキーワードで再検索し、タイトル+価格一致なら confident', async () => {
    mocks.scrapeUrl
      .mockRejectedValueOnce(new Error('検索結果が0件です'))
      .mockResolvedValueOnce([
        { sourceUrl: 'https://jp.mercari.com/item/m1', title: '【新品未開封】王の顔　韓国盤　ソ•イングク　韓国ドラマ', price: 47000, availability: 'available' },
        { sourceUrl: 'https://jp.mercari.com/item/m2', title: '王の顔 DVD-BOX', price: 12000, availability: 'available' },
      ])
    const result = await findSupplierMatch({ title: '【新品未開封】王の顔　韓国盤　ソ•イングク　　　　　　韓国ド', priceJpy: 47000 })
    expect(result.confident).toBe(true)
    expect(result.best?.sourceUrl).toBe('https://jp.mercari.com/item/m1')
    expect(mocks.scrapeUrl).toHaveBeenCalledTimes(2)
    expect(mocks.scrapeUrl.mock.calls[0][1]).toMatchObject({ skipDetailEnrichment: true })
  })

  it('同名商品が複数あっても価格が一致すれば confident、価格情報が無く僅差なら要確認', async () => {
    mocks.scrapeUrl.mockReset().mockResolvedValue([
      { sourceUrl: 'https://jp.mercari.com/item/a', title: 'X JAPAN プロモCD', price: 21111, availability: 'available' },
      { sourceUrl: 'https://jp.mercari.com/item/b', title: 'X JAPAN プロモCD', price: 15555, availability: 'available' },
    ])
    const withPrice = await findSupplierMatch({ title: 'X JAPAN プロモCD', priceJpy: 21111 })
    expect(withPrice.confident).toBe(true)
    expect(withPrice.best?.sourceUrl).toBe('https://jp.mercari.com/item/a')

    const withoutPrice = await findSupplierMatch({ title: 'X JAPAN プロモCD', priceJpy: null })
    expect(withoutPrice.confident).toBe(false)
    expect(withoutPrice.candidates).toHaveLength(2)
  })
})
