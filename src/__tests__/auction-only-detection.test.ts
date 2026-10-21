import { describe, expect, it } from 'vitest'
import { yahooAuctionPriceType } from '@/lib/scrapers/yahoo_auction'

// ユーザー報告(2026-10-20): 即決で仕入れるつもりの商品が、入札が入って
// 即決価格の無いオークションに変わっていた。
// 実データ g1248425199: 開始¥1,000 → 56件の入札で¥39,500、即決は消滅。
// eBayでは$176で売れたが、仕入値は約$258まで上がり落札できる保証も無い。
// ヤフオクは即決価格付きでも、入札が入ると即決が消えることがある。

describe('yahooAuctionPriceType', () => {
  it('即決価格があれば定額で買える', () => {
    expect(yahooAuctionPriceType({ price: 20700, bidorbuy: 20700, taxinBidorbuy: 22770 })).toBe('fixed')
  })

  // ここを見落とすと、落札しないと買えない商品を出品し続けてしまう
  it('即決価格が無ければオークション扱い', () => {
    expect(yahooAuctionPriceType({ price: 39500, initPrice: 1000, bids: 56 })).toBe('auction')
  })

  it('即決価格が0でもオークション扱い', () => {
    expect(yahooAuctionPriceType({ price: 1000, bidorbuy: 0, taxinBidorbuy: 0 })).toBe('auction')
  })

  it('税込の即決価格だけでも定額と判断する', () => {
    expect(yahooAuctionPriceType({ price: 26500, taxinBidorbuy: 29150 })).toBe('fixed')
  })

  it('文字列で返っても数値として扱う（PostgREST/JSONのゆらぎ対策）', () => {
    expect(yahooAuctionPriceType({ bidorbuy: '20700' })).toBe('fixed')
  })

  it('何も無ければオークション扱い（安全側に倒す）', () => {
    expect(yahooAuctionPriceType({})).toBe('auction')
    expect(yahooAuctionPriceType(null)).toBe('auction')
  })
})
