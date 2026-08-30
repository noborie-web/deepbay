import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { YahooAuctionScraper } from '../lib/scrapers/yahoo_auction'

// 実際の商品ページの__NEXT_DATA__構造を模した最小フィクスチャ
// (2026-08-29に実データで確認した構造に基づく)
const NEXT_DATA_ITEM_HTML = `
<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      initialState: {
        item: {
          detail: {
            item: {
              auctionId: 't1241554842',
              title: 'NIKE SHOX ブラック',
              price: 7500,
              img: [
                { image: 'https://example.com/1.jpg', width: 1200, height: 900 },
                { image: 'https://example.com/2.jpg', width: 1200, height: 900 },
              ],
              category: { path: [{ id: '0', name: 'オークション', node: 0 }, { id: '1', name: 'ファッション', node: 1 }, { id: '2', name: 'スニーカー', node: 2 }] },
              conditionName: 'やや傷や汚れあり',
              description: ['説明文1行目', '説明文2行目'],
              shipScheduleName: '支払い手続きから1～2日で発送',
              seller: { rating: { summary: 22 } },
              endTime: '2026-09-01T19:31:51+09:00',
            },
          },
        },
      },
    },
  },
})}</script></body></html>
`

describe('YahooAuctionScraper.parse (__NEXT_DATA__経由)', () => {
  it('__NEXT_DATA__の構造化データから正しく商品情報を抽出する', () => {
    const $ = cheerio.load(NEXT_DATA_ITEM_HTML)
    const scraper = new YahooAuctionScraper()
    const product = scraper.parse($, 'https://auctions.yahoo.co.jp/jp/auction/t1241554842')
    expect(product.sourceItemId).toBe('t1241554842')
    expect(product.title).toBe('NIKE SHOX ブラック')
    expect(product.price).toBe(7500)
    expect(product.images).toEqual(['https://example.com/1.jpg', 'https://example.com/2.jpg'])
    expect(product.condition).toBe('やや傷や汚れあり')
    expect(product.category).toBe('スニーカー') // カテゴリパスの末尾
    expect(product.description).toBe('説明文1行目\n説明文2行目')
    expect(product.shippingDays).toBe(1)
    expect(product.sellerRatingCount).toBe(22)
    expect(product.sourceUpdatedAt).toBe(new Date('2026-09-01T19:31:51+09:00').toISOString())
  })

  it('__NEXT_DATA__が無い場合はCSSセレクタのフォールバックにより空でもクラッシュしない', () => {
    const $ = cheerio.load('<html><body><h1 class="ProductTitle__text">フォールバック商品名</h1></body></html>')
    const scraper = new YahooAuctionScraper()
    const product = scraper.parse($, 'https://auctions.yahoo.co.jp/jp/auction/t999')
    expect(product.title).toBe('フォールバック商品名')
    expect(product.sourceItemId).toBe('t999')
  })
})

function fakeCard(id: string, price: number): string {
  return `<li class="Product"><a class="Product__imageLink" data-auction-id="${id}" data-auction-title="Item ${id}" data-auction-img="https://example.com/img/${id}.jpg?pri=l&amp;w=300&amp;h=300&amp;up=0" data-auction-price="${price}" href="https://auctions.yahoo.co.jp/jp/auction/${id}"></a></li>`
}

function searchPageHtml(cards: string[], totalCountText: string | null): string {
  const header = totalCountText ? `<div class="Result__header">すべて${totalCountText}件</div>` : ''
  return `<html><body>${header}<ul>${cards.join('')}</ul></body></html>`
}

describe('YahooAuctionScraper.matches', () => {
  it('単品ページURLにマッチする', () => {
    const scraper = new YahooAuctionScraper()
    expect(scraper.matches('https://auctions.yahoo.co.jp/jp/auction/t123')).toBe(true)
  })

  it('検索結果ページURLにもマッチする', () => {
    const scraper = new YahooAuctionScraper()
    expect(scraper.matches('https://auctions.yahoo.co.jp/search/search?p=nike')).toBe(true)
  })

  it('関係ないURLにはマッチしない', () => {
    const scraper = new YahooAuctionScraper()
    expect(scraper.matches('https://example.com/foo')).toBe(false)
  })
})

describe('YahooAuctionScraper.scrape 検索ページの一括抽出', () => {
  it('data-auction-*属性から商品情報を正しく抽出する', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([fakeCard('t100', 1000), fakeCard('t101', 2000)], '2,000'),
      { status: 200 },
    )

    try {
      const scraper = new YahooAuctionScraper()
      const results = await scraper.scrape('https://auctions.yahoo.co.jp/search/search?p=nike', { limit: 2 })
      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({
        sourceItemId: 't100',
        sourceUrl: 'https://auctions.yahoo.co.jp/jp/auction/t100',
        title: 'Item t100',
        price: 1000,
      })
      // サムネイルのw/hパラメータが大きい値に書き換えられている
      expect(results[0].images[0]).toContain('w=1200')
      expect(results[0].images[0]).toContain('h=1200')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('1ページの件数が少なくても、まだ総件数に達していなければ次ページを取得し続ける', async () => {
    // メルカリ・SnkrDunk検索抽出で見つかった不具合と同じケース:
    // 「返却件数の少なさ」を終了条件にしてはいけない。
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const b = new URL(urlStr).searchParams.get('b')
      requestCount += 1
      if (b === '1') {
        return new Response(searchPageHtml([fakeCard('a1', 100), fakeCard('a2', 200)], '5'), { status: 200 })
      }
      if (b === '51') {
        return new Response(searchPageHtml([fakeCard('a3', 300), fakeCard('a4', 400), fakeCard('a5', 500)], '5'), { status: 200 })
      }
      return new Response(searchPageHtml([], '5'), { status: 200 })
    }

    try {
      const scraper = new YahooAuctionScraper()
      const results = await scraper.scrape('https://auctions.yahoo.co.jp/search/search?p=nike', { limit: 600 })
      expect(results).toHaveLength(5)
      expect(requestCount).toBe(2) // 総件数5に達した時点で3ページ目は取得しない
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('空の結果が返ったページで終了する(総件数が取得できない場合のフォールバック)', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const b = new URL(urlStr).searchParams.get('b')
      requestCount += 1
      if (b === '1') {
        return new Response(searchPageHtml([fakeCard('x1', 100)], null), { status: 200 })
      }
      return new Response(searchPageHtml([], null), { status: 200 })
    }

    try {
      const scraper = new YahooAuctionScraper()
      const results = await scraper.scrape('https://auctions.yahoo.co.jp/search/search?p=nike', { limit: 600 })
      expect(results).toHaveLength(1)
      expect(requestCount).toBe(2)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('検索結果が0件ならエラーを投げる', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(searchPageHtml([], '0'), { status: 200 })

    try {
      const scraper = new YahooAuctionScraper()
      await expect(scraper.scrape('https://auctions.yahoo.co.jp/search/search?p=nonexistent')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

function fakeSellerNextData(items: { auctionId: string; title: string; price: number }[], total: number): string {
  const nd = {
    props: {
      pageProps: {
        initialState: {
          search: {
            items: {
              listing: {
                items: items.map((i) => ({
                  auctionId: i.auctionId,
                  title: i.title,
                  price: i.price,
                  imageUrl: `https://example.com/${i.auctionId}.jpg?w=300&h=300`,
                  itemCondition: 'NEW',
                  categoryPath: [{ id: 0, name: 'オークション' }, { id: 1, name: 'カテゴリA' }],
                  endTime: '2026-09-01T19:31:51+09:00',
                })),
                totalResultsAvailable: total,
              },
            },
          },
        },
      },
    },
  }
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script></body></html>`
}

describe('YahooAuctionScraper.matches (セラーページ)', () => {
  it('セラーページURLにマッチする', () => {
    const scraper = new YahooAuctionScraper()
    expect(scraper.matches('https://auctions.yahoo.co.jp/seller/F8G32f5djiiu1pJTiqwBK36jhXmrA')).toBe(true)
  })
})

describe('YahooAuctionScraper.scrape セラーページの一括抽出', () => {
  it('__NEXT_DATA__のlisting.itemsから商品情報を正しく抽出し、画像をアップサイズする', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      fakeSellerNextData([{ auctionId: 'a1', title: 'Item A1', price: 1000 }], 1),
      { status: 200 },
    )
    try {
      const scraper = new YahooAuctionScraper()
      const results = await scraper.scrape('https://auctions.yahoo.co.jp/seller/testseller', { limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        sourceItemId: 'a1',
        sourceUrl: 'https://auctions.yahoo.co.jp/jp/auction/a1',
        title: 'Item A1',
        price: 1000,
        condition: 'NEW',
        category: 'カテゴリA',
      })
      expect(results[0].images[0]).toContain('w=1200')
      expect(results[0].sourceUpdatedAt).toBe(new Date('2026-09-01T19:31:51+09:00').toISOString())
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('1ページの件数が少なくても、まだ総件数に達していなければ次ページを取得し続ける', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const b = new URL(urlStr).searchParams.get('b')
      requestCount += 1
      if (b === '1') {
        return new Response(fakeSellerNextData([{ auctionId: 'b1', title: 'B1', price: 100 }, { auctionId: 'b2', title: 'B2', price: 200 }], 5), { status: 200 })
      }
      if (b === '51') {
        return new Response(fakeSellerNextData([
          { auctionId: 'b3', title: 'B3', price: 300 },
          { auctionId: 'b4', title: 'B4', price: 400 },
          { auctionId: 'b5', title: 'B5', price: 500 },
        ], 5), { status: 200 })
      }
      return new Response(fakeSellerNextData([], 5), { status: 200 })
    }
    try {
      const scraper = new YahooAuctionScraper()
      const results = await scraper.scrape('https://auctions.yahoo.co.jp/seller/testseller', { limit: 600 })
      expect(results).toHaveLength(5)
      expect(requestCount).toBe(2) // 総件数5に達した時点で3ページ目は取得しない
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('出品者の商品が0件ならエラーを投げる', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(fakeSellerNextData([], 0), { status: 200 })
    try {
      const scraper = new YahooAuctionScraper()
      await expect(scraper.scrape('https://auctions.yahoo.co.jp/seller/emptyseller')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
