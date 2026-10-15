import { describe, expect, it } from 'vitest'
import {
  YahooAuctionScraper,
  parseYahooAuctionSearchData,
  yahooAuctionItemCondition,
  yahooAuctionTaxInPrice,
} from '@/lib/scrapers/yahoo_auction'

// ユーザー報告(2026-10-15): カテゴリの一覧URLが「このURLには対応していません」で
// 弾かれた。実際に確認したところ、ヤフオク側が2つ変わっていた:
//   1. /search/search?auccat=... は /category/list/{id} へ302リダイレクトされる
//   2. 検索結果の商品が旧HTML(a.Product__imageLink[data-auction-id])から
//      __NEXT_DATA__ の search.items.listing に移った
// 2はキーワード検索にも及んでいて、カテゴリURLを受け付けるだけでは直らない。

function nextDataHtml(payload: unknown): string {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`
}

// 本番の /category/list/2084064354 から取った実データの形
const realShape = {
  props: {
    pageProps: {
      initialState: {
        search: {
          items: {
            listing: {
              items: [
                {
                  auctionId: 'u1241702924',
                  title: 'Abu Garcia アブガルシア カーディナル pro T500F 傷や汚れあり',
                  price: 7590,
                  buyNowPrice: 7590,
                  imageUrl: 'https://auc-pctr.c.yimg.jp/i/image.jpg?pri=l&w=300&h=300',
                  itemCondition: 'USED60',
                  seller: { userId: '4pBThVzpygUcwNHdRDXpQtB5fLYEy' },
                },
              ],
              totalResultsAvailable: 132,
              metadata: {
                categories: [{
                  path: [
                    { id: 0, name: 'すべて' },
                    { id: 24698, name: 'スポーツ、レジャー' },
                    { id: 25182, name: 'リール' },
                  ],
                }],
              },
            },
          },
        },
      },
    },
  },
}

describe('ヤフオクのURL判定', () => {
  const scraper = new YahooAuctionScraper()

  it('カテゴリ一覧URLを受け付ける（ユーザー報告のURL）', () => {
    expect(scraper.matches(
      'https://auctions.yahoo.co.jp/category/list/2084064354?fixed=1&auccat=2084064354&price_type=bidorbuyprice&min=5000&max=50000',
    )).toBe(true)
  })

  it('従来のキーワード検索URLも受け付ける', () => {
    expect(scraper.matches('https://auctions.yahoo.co.jp/search/search?p=%E3%82%A2%E3%83%96')).toBe(true)
  })

  it('商品ページ・セラーページも従来どおり受け付ける', () => {
    expect(scraper.matches('https://auctions.yahoo.co.jp/jp/auction/u1241702924')).toBe(true)
    expect(scraper.matches('https://auctions.yahoo.co.jp/seller/4pBThVzpygUc')).toBe(true)
  })

  it('他サイトのURLは受け付けない', () => {
    expect(scraper.matches('https://paypayfleamarket.yahoo.co.jp/search/abc')).toBe(false)
    expect(scraper.matches('https://jp.mercari.com/search?keyword=abc')).toBe(false)
  })
})

describe('parseYahooAuctionSearchData', () => {
  it('__NEXT_DATA__から商品・総件数・カテゴリ階層を取り出す', () => {
    const data = parseYahooAuctionSearchData(nextDataHtml(realShape))
    expect(data).not.toBeNull()
    expect(data!.totalResultsAvailable).toBe(132)
    expect(data!.items).toHaveLength(1)
    expect(data!.items[0].auctionId).toBe('u1241702924')
    // 先頭の「すべて」(id=0)はYahoo!フリマ側の検索条件にならないので除く
    expect(data!.categoryPath).toEqual(['スポーツ、レジャー', 'リール'])
  })

  it('__NEXT_DATA__が無いページではnullを返す（旧HTMLの解析に落とすため）', () => {
    expect(parseYahooAuctionSearchData('<html><body>no next data</body></html>')).toBeNull()
  })

  it('壊れたJSONでも例外にせずnullを返す', () => {
    expect(parseYahooAuctionSearchData(
      '<script id="__NEXT_DATA__" type="application/json">{broken</script>',
    )).toBeNull()
  })

  it('検索結果が入っていない形でもnullを返す', () => {
    expect(parseYahooAuctionSearchData(nextDataHtml({ props: { pageProps: {} } }))).toBeNull()
  })
})

describe('yahooAuctionItemCondition', () => {
  // USED40=「やや傷や汚れあり」/ USED60=「傷や汚れあり」は実際の商品ページと
  // 突き合わせて確認済み。残りはヤフオクの6段階の並び順。
  it('ヤフオクの状態コードを日本語の状態に直す', () => {
    expect(yahooAuctionItemCondition('USED40')).toBe('やや傷や汚れあり')
    expect(yahooAuctionItemCondition('USED60')).toBe('傷や汚れあり')
    expect(yahooAuctionItemCondition('NEW')).toBe('新品、未使用')
  })

  it('知らないコード・未指定はnull（誤ったConditionIDを付けない）', () => {
    expect(yahooAuctionItemCondition('UNKNOWN_CODE')).toBeNull()
    expect(yahooAuctionItemCondition(undefined)).toBeNull()
  })
})

describe('カテゴリ一覧の取得', () => {
  it('__NEXT_DATA__の商品を取り込み、セラーURL・状態・即決価格を埋める', async () => {
    const scraper = new YahooAuctionScraper()
    const html = nextDataHtml(realShape)
    const fetchMock = async () => new Response(html, { status: 200 })
    const original = globalThis.fetch
    globalThis.fetch = fetchMock as typeof globalThis.fetch
    try {
      const products = await scraper.scrape(
        'https://auctions.yahoo.co.jp/category/list/2084064354?auccat=2084064354',
        { limit: 10, skipDetailEnrichment: true },
      )
      expect(products).toHaveLength(1)
      expect(products[0]).toMatchObject({
        sourceItemId: 'u1241702924',
        sourceUrl: 'https://auctions.yahoo.co.jp/jp/auction/u1241702924',
        sourceSite: 'yahoo_auction',
        price: 7590,
        condition: '傷や汚れあり',
        // seller.userId はセラーページURLの識別子と一致することを実データで確認済み
        sellerUrl: 'https://auctions.yahoo.co.jp/seller/4pBThVzpygUcwNHdRDXpQtB5fLYEy',
      })
      // サムネイルは大きいサイズに書き換える
      expect(products[0].images[0]).toContain('w=1200')
    } finally {
      globalThis.fetch = original
    }
  })
})

// 本番で確認した不具合(2026-10-15): 商品ページの解析が**税抜**価格を取っていた。
// 実データ(t1241692266)は税抜26,500 / 税込29,150で、仕入値を10%低く
// 見積もると利益計算がそのぶん甘くなる。ユーザーのカテゴリ検索132件のうち
// 33件(25%)が課税セラーの出品だった。
describe('yahooAuctionTaxInPrice', () => {
  it('税込の即決価格を優先する（無在庫で実際に支払う額）', () => {
    expect(yahooAuctionTaxInPrice({
      price: 26500, bidorbuy: 26500, taxinPrice: 29150, taxinBidorbuy: 29150,
    })).toBe(29150)
  })

  it('即決が無ければ税込の現在価格を使う', () => {
    expect(yahooAuctionTaxInPrice({ price: 5000, taxinPrice: 5500 })).toBe(5500)
  })

  it('税込が取れなければ税抜に落とす（0件にしない）', () => {
    expect(yahooAuctionTaxInPrice({ price: 5000 })).toBe(5000)
    expect(yahooAuctionTaxInPrice({ bidorbuy: 7000 })).toBe(7000)
  })

  it('非課税セラーでは税込と税抜が同じなので値は変わらない', () => {
    expect(yahooAuctionTaxInPrice({ price: 12840, taxinPrice: 12840 })).toBe(12840)
  })

  it('価格が無い・0ならnull（0円で出品しない）', () => {
    expect(yahooAuctionTaxInPrice({})).toBeNull()
    expect(yahooAuctionTaxInPrice({ price: 0, taxinPrice: 0 })).toBeNull()
    expect(yahooAuctionTaxInPrice(null)).toBeNull()
  })
})

// 本番で確認した取りこぼし(2026-10-15): ユーザーの抽出が109件で、総件数131件に
// 届かなかった。ヤフオクは取得のたびに並びが変わるため、ページをまたいで同じ
// 商品が重複して返り、そのぶん別の商品が1件も出てこない。
// 実測: 1巡目109件 → もう1巡で残り22件が出て131件そろった。
describe('並びの入れ替わりによる取りこぼしの拾い直し', () => {
  // 1巡目は重複込みで返し(ユニーク2件)、2巡目で残りを返すヤフオクを模す
  function shufflingYahoo(pages: string[][][], total: number) {
    let sweep = -1
    let pageInSweep = 0
    return async (input: string | URL | Request) => {
      const b = Number(new URL(String(input)).searchParams.get('b') ?? '1')
      if (b === 1) { sweep += 1; pageInSweep = 0 } else { pageInSweep += 1 }
      const ids = pages[Math.min(sweep, pages.length - 1)]?.[pageInSweep] ?? []
      return new Response(nextDataHtml({
        props: { pageProps: { initialState: { search: { items: { listing: {
          items: ids.map(id => ({
            auctionId: id, title: `商品 ${id}`, price: 1000, buyNowPrice: 1000,
            imageUrl: 'https://example.com/i.jpg?w=300', itemCondition: 'NEW',
            seller: { userId: 'seller1' },
          })),
          totalResultsAvailable: total,
        } } } } } },
      }), { status: 200 })
    }
  }

  it('総件数に届かなければ取り直して、取りこぼした商品を拾う', async () => {
    const scraper = new YahooAuctionScraper()
    const original = globalThis.fetch
    // 1巡目: a,b / b,c(重複) → ユニーク3件。2巡目で d,e が出て5件そろう
    globalThis.fetch = shufflingYahoo([
      [['a', 'b'], ['b', 'c'], []],
      [['a', 'd'], ['e', 'c'], []],
    ], 5) as typeof globalThis.fetch
    try {
      const products = await scraper.scrape(
        'https://auctions.yahoo.co.jp/category/list/123', { limit: 600, skipDetailEnrichment: true },
      )
      expect(products.map(p => p.sourceItemId).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('取り直しても増えなければ打ち切る（終了済みで総件数に届かない場合）', async () => {
    const scraper = new YahooAuctionScraper()
    const original = globalThis.fetch
    // 何度取り直しても同じ2件しか返らない。総件数は99と言っている
    globalThis.fetch = shufflingYahoo([[['a', 'b'], []]], 99) as typeof globalThis.fetch
    try {
      const products = await scraper.scrape(
        'https://auctions.yahoo.co.jp/category/list/123', { limit: 600, skipDetailEnrichment: true },
      )
      // 取れた分は捨てない
      expect(products.map(p => p.sourceItemId)).toEqual(['a', 'b'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('1巡目で総件数に届けば取り直さない（余計なリクエストを投げない）', async () => {
    const scraper = new YahooAuctionScraper()
    const original = globalThis.fetch
    let requests = 0
    const inner = shufflingYahoo([[['a', 'b'], []]], 2)
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests += 1
      return inner(input)
    }) as typeof globalThis.fetch
    try {
      const products = await scraper.scrape(
        'https://auctions.yahoo.co.jp/category/list/123', { limit: 600, skipDetailEnrichment: true },
      )
      expect(products).toHaveLength(2)
      // 1ページ目で2件=総件数に達するので、2ページ目以降は取りに行かない
      expect(requests).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
