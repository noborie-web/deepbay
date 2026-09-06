import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { RakumaScraper } from '../lib/scrapers/rakuma'

function fakeCard(id: string, name: string, price: number, totalResults?: number, soldOut = false): string {
  const totalAttr = totalResults !== undefined ? ` data-rat-cp-totalresults="${totalResults}"` : ''
  // 実際のページで確認: 売り切れ商品の検索結果カードには
  // <div class="item-box__soldout_ribbon">SOLD OUT</div>が含まれる。
  const ribbon = soldOut ? '<div class="item-box__soldout_ribbon">SOLD OUT</div>' : ''
  return `<a href="https://item.fril.jp/${id}" data-rat-item_name="${name}" data-rat-price="${price}"${totalAttr}><img data-original="https://img.fril.jp/img/999/m/${id}.jpg">${ribbon}</a>`
}

function searchPageHtml(cards: string[]): string {
  return `<html><body><div class="results">${cards.join('')}</div></body></html>`
}

const NEXT_ITEM_HTML = `
<html><head>
  <meta property="og:title" content="ナイキ29㎝ゴルフシューズ | フリマアプリ ラクマ" />
  <meta property="og:description" content="中古です！ナイキサイズは、28センチ" />
  <meta property="og:image" content="https://img.fril.jp/img/119621913/l/2938351680.jpg?1788044029" />
  <meta property="product:price:amount" content="1900" />
  <meta property="product:retailer_item_id" content="119621913" />
  <meta property="product:availability" content="in stock" />
</head>
<body>
  <p class="item__value_area"><span class="item__price"><span class="item__currency-symbol">¥</span>1,900</span></p>
  <table>
    <tr><th>商品の状態</th><td>やや傷や汚れあり</td></tr>
    <tr><th>発送日の目安</th><td>支払い後、4～7日で発送</td></tr>
  </table>
  <nav><ul class="breadcrumbs">
    <li><a href="https://fril.jp/">ラクマ</a></li>
    <li><a href="https://fril.jp/brand/592">NIKE</a></li>
    <li><a href="https://fril.jp/brand/592/category/10014">スポーツ/アウトドア</a></li>
    <li><a href="https://fril.jp/brand/592/category/1095">ゴルフ</a></li>
  </ul></nav>
  <div class="item__description__line-limited"><span> 中古です！<br>ナイキ<br>サイズは、28センチ<br> </span></div>
  <div>取引の評価<div class="review-list"><ul class="list-inline"><li><span>234</span></li></ul></div></div>
  <img src="https://img.fril.jp/img/119621913/l/2938351678.jpg?1788044029">
  <img src="https://img.fril.jp/img/119621913/l/2938351679.jpg?1788044029">
  <img src="https://img.fril.jp/img/119621913/l/2938351680.jpg?1788044029">
  <div class="row header-shopinfo shopinfo-area">
    <a class="shopinfo-wrap shop_link clearfix" href="https://fril.jp/shop/7adc49225dc95e2039e789ae60b918e9">ショップへ</a>
  </div>
</body></html>
`

describe('RakumaScraper.matches', () => {
  it('単品ページURL(item.fril.jpサブドメイン)にマッチする', () => {
    const scraper = new RakumaScraper()
    expect(scraper.matches('https://item.fril.jp/4ab327d7c041d8ef2b439aa983095621')).toBe(true)
  })

  it('検索結果ページURLにもマッチする', () => {
    const scraper = new RakumaScraper()
    expect(scraper.matches('https://fril.jp/s?query=nike')).toBe(true)
  })

  it('関係ないURLにはマッチしない', () => {
    const scraper = new RakumaScraper()
    expect(scraper.matches('https://example.com/foo')).toBe(false)
  })
})

describe('RakumaScraper.parse (単品ページ)', () => {
  it('メタタグ・表組み・パンくずから正しく商品情報を抽出する', () => {
    const $ = cheerio.load(NEXT_ITEM_HTML)
    const scraper = new RakumaScraper()
    const product = scraper.parse($, 'https://item.fril.jp/4ab327d7c041d8ef2b439aa983095621')
    expect(product.sourceItemId).toBe('4ab327d7c041d8ef2b439aa983095621')
    expect(product.title).toBe('ナイキ29㎝ゴルフシューズ')
    expect(product.price).toBe(1900)
    expect(product.condition).toBe('やや傷や汚れあり')
    expect(product.category).toBe('ゴルフ')
    expect(product.shippingDays).toBe(4)
    expect(product.sellerRatingCount).toBe(234)
    expect(product.images).toHaveLength(3)
    expect(product.images).toContain('https://img.fril.jp/img/119621913/l/2938351680.jpg?1788044029')
    // 危険セラー除外の個別商品判定用(実データ確認: 商品ページの
    // ショップ情報リンクfril.jp/shop/{id})
    expect(product.sellerUrl).toBe('https://fril.jp/shop/7adc49225dc95e2039e789ae60b918e9')
    // 実データ確認: 在庫あり商品は<meta property="product:availability" content="in stock">
    expect(product.availability).toBe('available')
  })
})

// 実際の商品ページを比較して確認した売り切れ検知の実データ(2026-09-06):
// 在庫あり商品は<meta property="product:availability" content="in stock">、
// 売り切れ商品は同content="out of stock"になる。
describe('RakumaScraper.parse (売り切れ検知)', () => {
  function itemHtmlWithAvailability(content: string): string {
    return `
<html><head>
  <meta property="og:title" content="売り切れテスト商品 | フリマアプリ ラクマ" />
  <meta property="product:price:amount" content="1900" />
  <meta property="product:availability" content="${content}" />
</head>
<body>
  <div class="photo-box__soldout_ribbon">SOLD OUT</div>
</body></html>`
  }

  it('product:availabilityが"in stock"の場合はavailableになる', () => {
    const $ = cheerio.load(itemHtmlWithAvailability('in stock'))
    const scraper = new RakumaScraper()
    const product = scraper.parse($, 'https://item.fril.jp/soldouttest')
    expect(product.availability).toBe('available')
  })

  it('product:availabilityが"out of stock"の場合はsold_outになる', () => {
    const $ = cheerio.load(itemHtmlWithAvailability('out of stock'))
    const scraper = new RakumaScraper()
    const product = scraper.parse($, 'https://item.fril.jp/soldouttest')
    expect(product.availability).toBe('sold_out')
  })
})

describe('RakumaScraper.scrape 検索ページの一括抽出', () => {
  it('data-rat-*属性から商品情報を正しく抽出し、画像を大サイズにアップサイズする', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([fakeCard('a1', 'Item A1', 1000, 2), fakeCard('a2', 'Item A2', 2000)]),
      { status: 200 },
    )
    try {
      const scraper = new RakumaScraper()
      const results = await scraper.scrape('https://fril.jp/s?query=nike', { limit: 2 })
      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({ sourceItemId: 'a1', price: 1000, title: 'Item A1' })
      expect(results[0].images[0]).toContain('/l/')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('検索結果カードのSOLD OUTリボンから売り切れ商品を判定する', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([
        fakeCard('a1', 'Item A1', 1000, 2, true),
        fakeCard('a2', 'Item A2', 2000, undefined, false),
      ]),
      { status: 200 },
    )
    try {
      const scraper = new RakumaScraper()
      const results = await scraper.scrape('https://fril.jp/s?query=nike', { limit: 2 })
      expect(results.find((p) => p.sourceItemId === 'a1')?.availability).toBe('sold_out')
      expect(results.find((p) => p.sourceItemId === 'a2')?.availability).toBe('available')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('1ページの件数が少なくても、まだ総件数に達していなければ次ページを取得し続ける', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const page = new URL(urlStr).searchParams.get('page') ?? '1'
      requestCount += 1
      if (page === '1') {
        return new Response(searchPageHtml([fakeCard('b1', 'B1', 100, 5), fakeCard('b2', 'B2', 200)]), { status: 200 })
      }
      if (page === '2') {
        return new Response(searchPageHtml([fakeCard('b3', 'B3', 300), fakeCard('b4', 'B4', 400), fakeCard('b5', 'B5', 500)]), { status: 200 })
      }
      return new Response(searchPageHtml([]), { status: 200 })
    }
    try {
      const scraper = new RakumaScraper()
      const results = await scraper.scrape('https://fril.jp/s?query=nike', { limit: 600 })
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
      const page = new URL(urlStr).searchParams.get('page') ?? '1'
      requestCount += 1
      if (page === '1') return new Response(searchPageHtml([fakeCard('c1', 'C1', 100)]), { status: 200 })
      return new Response(searchPageHtml([]), { status: 200 })
    }
    try {
      const scraper = new RakumaScraper()
      const results = await scraper.scrape('https://fril.jp/s?query=nike', { limit: 600 })
      expect(results).toHaveLength(1)
      expect(requestCount).toBe(2)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('検索結果が0件ならエラーを投げる', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(searchPageHtml([]), { status: 200 })
    try {
      const scraper = new RakumaScraper()
      await expect(scraper.scrape('https://fril.jp/s?query=nonexistent')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })

  // ユーザー要望: ラクマの検索結果一括抽出でも危険セラー除外を有効にする。
  // 検索結果カードには出品者情報が含まれないため、fetchSellerInfoが
  // 指定された場合のみ商品ごとに個別ページへアクセスして取得する。
  it('fetchSellerInfoが指定されていない場合、商品ごとの追加アクセスをせずsellerUrlは設定しない', async () => {
    let itemPageRequests = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      if (urlStr.startsWith('https://item.fril.jp/')) itemPageRequests += 1
      return new Response(searchPageHtml([fakeCard('a1', 'Item A1', 1000, 1)]), { status: 200 })
    }
    try {
      const scraper = new RakumaScraper()
      const results = await scraper.scrape('https://fril.jp/s?query=nike', { limit: 1 })
      expect(results[0].sellerUrl).toBeUndefined()
      expect(itemPageRequests).toBe(0)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('fetchSellerInfo:trueの場合、商品ごとに個別ページへアクセスして出品者URLを取得する', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      if (urlStr === 'https://item.fril.jp/a1') {
        return new Response(
          '<html><body><a class="shop_link" href="https://fril.jp/shop/seller-a">ショップへ</a></body></html>',
          { status: 200 },
        )
      }
      if (urlStr === 'https://item.fril.jp/a2') {
        return new Response('<html><body>出品者リンクなし</body></html>', { status: 200 })
      }
      return new Response(
        searchPageHtml([fakeCard('a1', 'Item A1', 1000, 2), fakeCard('a2', 'Item A2', 2000)]),
        { status: 200 },
      )
    }
    try {
      const scraper = new RakumaScraper()
      const results = await scraper.scrape('https://fril.jp/s?query=nike', { limit: 2, fetchSellerInfo: true })
      expect(results.find((p) => p.sourceItemId === 'a1')?.sellerUrl).toBe('https://fril.jp/shop/seller-a')
      expect(results.find((p) => p.sourceItemId === 'a2')?.sellerUrl).toBeNull()
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('個別ページの取得に失敗しても、抽出全体は失敗せずsellerUrl未設定のまま商品を返す', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      if (urlStr === 'https://item.fril.jp/a1') {
        return new Response('error', { status: 500 })
      }
      return new Response(searchPageHtml([fakeCard('a1', 'Item A1', 1000, 1)]), { status: 200 })
    }
    try {
      const scraper = new RakumaScraper()
      const results = await scraper.scrape('https://fril.jp/s?query=nike', { limit: 1, fetchSellerInfo: true })
      expect(results).toHaveLength(1)
      expect(results[0].sellerUrl).toBeUndefined()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
