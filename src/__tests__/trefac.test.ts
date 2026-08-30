import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { TrefacScraper } from '../lib/scrapers/trefac'

const SAMPLE_HTML = `
<html>
<head>
  <meta property="og:title" content="[中古]BURBERRY(バーバリー)のレディース 財布/小物 3つ折り財布"/>
  <script type="application/ld+json">
  {"@context":"http://schema.org","@type":"Product","name":"BURBERRY (バーバリー) 3つ折り財布","mpn":"1003007257179003","sku":"4330114","brand":{"@type":"Thing","name":"BURBERRY"},"description":"【アイテム名】3つ折り財布【型番】ITTIVGR058CAL","image":["https://www.trefac.jp/image/item/1003007257179003/1.jpeg","https://www.trefac.jp/image/item/1003007257179003/2.jpeg"],"offers":{"@type":"Offer","priceCurrency":"JPY","price":"16000","itemCondition":"http://schema.org/UsedCondition","availability":"http://schema.org/InStock"}}
  </script>
</head>
<body></body>
</html>
`

describe('TrefacScraper.parse', () => {
  it('extracts title from the Product JSON-LD', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new TrefacScraper()
    const product = scraper.parse($, 'https://www.trefac.jp/store/1003007257179003/c4330114/')
    expect(product.title).toBe('BURBERRY (バーバリー) 3つ折り財布')
  })

  it('extracts sourceItemId (the store item code) from the URL', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new TrefacScraper()
    const product = scraper.parse($, 'https://www.trefac.jp/store/1003007257179003/c4330114/')
    expect(product.sourceItemId).toBe('c4330114')
  })

  it('extracts price from offers.price as a number', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new TrefacScraper()
    const product = scraper.parse($, 'https://www.trefac.jp/store/1003007257179003/c4330114/')
    expect(product.price).toBe(16000)
  })

  it('maps schema.org UsedCondition to 中古', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new TrefacScraper()
    const product = scraper.parse($, 'https://www.trefac.jp/store/1003007257179003/c4330114/')
    expect(product.condition).toBe('中古')
  })

  it('uses the brand name as category', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new TrefacScraper()
    const product = scraper.parse($, 'https://www.trefac.jp/store/1003007257179003/c4330114/')
    expect(product.category).toBe('BURBERRY')
  })

  it('extracts all images from the image array', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new TrefacScraper()
    const product = scraper.parse($, 'https://www.trefac.jp/store/1003007257179003/c4330114/')
    expect(product.images).toEqual([
      'https://www.trefac.jp/image/item/1003007257179003/1.jpeg',
      'https://www.trefac.jp/image/item/1003007257179003/2.jpeg',
    ])
  })

  it('falls back to og:title when no Product JSON-LD is present', () => {
    const html = `<html><head><meta property="og:title" content="フォールバック商品名"/></head><body></body></html>`
    const $ = cheerio.load(html)
    const scraper = new TrefacScraper()
    const product = scraper.parse($, 'https://www.trefac.jp/store/999/c1/')
    expect(product.title).toBe('フォールバック商品名')
    expect(product.price).toBeNull()
    expect(product.condition).toBeNull()
  })

  it('matches trefac store item URLs via urlPattern', () => {
    const scraper = new TrefacScraper()
    expect(scraper.urlPattern.test('https://www.trefac.jp/store/1003007257179003/c4330114/')).toBe(true)
    expect(scraper.urlPattern.test('https://vector-park.jp/item/004-202608280393/')).toBe(false)
  })
})

describe('TrefacScraper.matches', () => {
  it('単品ページURLにマッチする', () => {
    const scraper = new TrefacScraper()
    expect(scraper.matches('https://www.trefac.jp/store/1003007257179003/c4330114/')).toBe(true)
  })

  it('検索結果ページURLにもマッチする', () => {
    const scraper = new TrefacScraper()
    expect(scraper.matches('https://www.trefac.jp/store/search_result.html?srchword=nike')).toBe(true)
  })

  it('関係ないURLにはマッチしない', () => {
    const scraper = new TrefacScraper()
    expect(scraper.matches('https://example.com/foo')).toBe(false)
  })
})

function fakeSearchItem(id: string, brand: string, name: string, priceClass: string, price: number): string {
  return `<li class="p-itemlist_item">
    <a href="/store/x/${id}/" class="p-itemlist_btn">
      <p class="p-itemlist_img"><img src="https://www.trefac.jp/image/item/x/w144/x_01_abcd.jpeg" alt="${brand}）の古着「${name}」｜色"></p>
      <p class="p-itemlist_brand">${brand}</p>
      <p class="${priceClass}">&yen;${price} <span class="p-typo_caption1">税込</span></p>
    </a>
  </li>`
}

function searchPageHtml(items: string[], totalCountText: string | null): string {
  const total = totalCountText ? `<span class="search_result_num">${totalCountText}</span>` : ''
  return `<html><body>${total}${items.join('')}</body></html>`
}

describe('TrefacScraper.scrape 検索ページの一括抽出', () => {
  it('通常価格(p-price2_a)・セール価格(p-price2_b)どちらのクラスからも価格を取得する', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([
        fakeSearchItem('c1', 'NIKE', 'Item One', 'p-price2_a', 1000),
        fakeSearchItem('c2', 'NIKE', 'Item Two', 'p-price2_b', 2000),
      ], '2'),
      { status: 200 },
    )
    try {
      const scraper = new TrefacScraper()
      const results = await scraper.scrape('https://www.trefac.jp/store/search_result.html?srchword=nike', { limit: 2 })
      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({ sourceItemId: 'c1', price: 1000, title: 'NIKE Item One' })
      expect(results[1]).toMatchObject({ sourceItemId: 'c2', price: 2000, title: 'NIKE Item Two' })
      expect(results[0].images[0]).not.toContain('/w144/')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('1ページの件数が少なくても、まだ総件数に達していなければ次ページを取得し続ける', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const key = new URL(urlStr).searchParams.get('key') ?? '1'
      requestCount += 1
      if (key === '1') {
        return new Response(searchPageHtml([fakeSearchItem('c101', 'B', 'A1', 'p-price2_a', 100), fakeSearchItem('c102', 'B', 'A2', 'p-price2_a', 200)], '5'), { status: 200 })
      }
      if (key === '2') {
        return new Response(searchPageHtml([fakeSearchItem('c103', 'B', 'A3', 'p-price2_a', 300), fakeSearchItem('c104', 'B', 'A4', 'p-price2_a', 400), fakeSearchItem('c105', 'B', 'A5', 'p-price2_a', 500)], '5'), { status: 200 })
      }
      return new Response(searchPageHtml([], '5'), { status: 200 })
    }
    try {
      const scraper = new TrefacScraper()
      const results = await scraper.scrape('https://www.trefac.jp/store/search_result.html?srchword=nike', { limit: 600 })
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
      const key = new URL(urlStr).searchParams.get('key') ?? '1'
      requestCount += 1
      if (key === '1') return new Response(searchPageHtml([fakeSearchItem('c201', 'B', 'Q1', 'p-price2_a', 100)], null), { status: 200 })
      return new Response(searchPageHtml([], null), { status: 200 })
    }
    try {
      const scraper = new TrefacScraper()
      const results = await scraper.scrape('https://www.trefac.jp/store/search_result.html?srchword=nike', { limit: 600 })
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
      const scraper = new TrefacScraper()
      await expect(scraper.scrape('https://www.trefac.jp/store/search_result.html?srchword=nonexistent')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
