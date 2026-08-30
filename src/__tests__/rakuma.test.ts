import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { RakumaScraper } from '../lib/scrapers/rakuma'

function fakeCard(id: string, name: string, price: number, totalResults?: number): string {
  const totalAttr = totalResults !== undefined ? ` data-rat-cp-totalresults="${totalResults}"` : ''
  return `<a href="https://item.fril.jp/${id}" data-rat-item_name="${name}" data-rat-price="${price}"${totalAttr}><img data-original="https://img.fril.jp/img/999/m/${id}.jpg"></a>`
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
})
