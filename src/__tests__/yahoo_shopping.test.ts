import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { YahooShoppingScraper } from '../lib/scrapers/yahoo_shopping'

const SAMPLE_HTML = `
<html>
<head>
  <title>OM SYSTEM Tough TG-7 BLK ブラック 防水・防塵・耐衝撃 デジタルカメラ : イーベスト - 通販 - Yahoo!ショッピング</title>
  <meta property="og:title" content="OM SYSTEM Tough TG-7 BLK ブラック 防水・防塵・耐衝撃 デジタルカメラ : イーベスト - 通販 - Yahoo!ショッピング"/>
  <meta property="og:image" content="https://item-shopping.c.yimg.jp/i/n/ebest_4545350055974_i_20251022043606"/>
  <meta property="og:description" content="■水深15mの高い防水性と砂や埃に強い防塵性"/>
  <meta property="product:price:amount" content="64980"/>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"item":{"@id":"https://store.shopping.yahoo.co.jp/ebest/","name":"イーベスト"}},{"@type":"ListItem","position":2,"item":{"@id":"https://store.shopping.yahoo.co.jp/ebest/a.html","name":"カメラ"}},{"@type":"ListItem","position":3,"item":{"@id":"https://store.shopping.yahoo.co.jp/ebest/b.html","name":"コンパクトデジカメ"}}]}</script>
</head>
<body></body>
</html>
`

describe('YahooShoppingScraper.parse', () => {
  it('extracts title without the trailing site-name suffix', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new YahooShoppingScraper()
    const product = scraper.parse($, 'https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')
    expect(product.title).toBe('OM SYSTEM Tough TG-7 BLK ブラック 防水・防塵・耐衝撃 デジタルカメラ')
  })

  it('extracts sourceItemId from the URL', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new YahooShoppingScraper()
    const product = scraper.parse($, 'https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')
    expect(product.sourceItemId).toBe('4545350055974')
  })

  it('extracts price from product:price:amount', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new YahooShoppingScraper()
    const product = scraper.parse($, 'https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')
    expect(product.price).toBe(64980)
  })

  it('extracts the most specific category from BreadcrumbList JSON-LD', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new YahooShoppingScraper()
    const product = scraper.parse($, 'https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')
    expect(product.category).toBe('コンパクトデジカメ')
  })

  it('extracts description and og:image', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new YahooShoppingScraper()
    const product = scraper.parse($, 'https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')
    expect(product.description).toBe('■水深15mの高い防水性と砂や埃に強い防塵性')
    expect(product.images).toEqual(['https://item-shopping.c.yimg.jp/i/n/ebest_4545350055974_i_20251022043606'])
  })

  it('falls back to the <title> tag when og:title is missing', () => {
    const html = `
      <html><head>
        <title>フォールバックタイトル : ストア名 - 通販 - Yahoo!ショッピング</title>
      </head><body></body></html>
    `
    const $ = cheerio.load(html)
    const scraper = new YahooShoppingScraper()
    const product = scraper.parse($, 'https://store.shopping.yahoo.co.jp/store1/item1.html')
    expect(product.title).toBe('フォールバックタイトル')
  })

  it('returns null category when no BreadcrumbList JSON-LD is present', () => {
    const html = `<html><head><meta property="og:title" content="タイトル"/></head><body></body></html>`
    const $ = cheerio.load(html)
    const scraper = new YahooShoppingScraper()
    const product = scraper.parse($, 'https://store.shopping.yahoo.co.jp/store1/item1.html')
    expect(product.category).toBeNull()
  })

  it('matches Yahoo Shopping product URLs via urlPattern', () => {
    const scraper = new YahooShoppingScraper()
    expect(scraper.urlPattern.test('https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')).toBe(true)
    expect(scraper.urlPattern.test('https://www.digimart.net/cat1/shop1484/DS10704096/')).toBe(false)
  })
})

describe('YahooShoppingScraper.matches', () => {
  it('単品ページURLにマッチする', () => {
    const scraper = new YahooShoppingScraper()
    expect(scraper.matches('https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')).toBe(true)
  })

  it('検索結果ページURLにもマッチする', () => {
    const scraper = new YahooShoppingScraper()
    expect(scraper.matches('https://shopping.yahoo.co.jp/search/Nike/0/')).toBe(true)
  })

  it('関係ないURLにはマッチしない', () => {
    const scraper = new YahooShoppingScraper()
    expect(scraper.matches('https://example.com/foo')).toBe(false)
  })
})

function fakeItemLink(storeId: string, itemCode: string, title: string, price: number, imgSrc: string): string {
  const beacon = `_cl_link:img;itemcode:${itemCode};storeid:${storeId};tname:${title};prc:${price};str_rct:100`
  return `<a href="https://store.shopping.yahoo.co.jp/${storeId}/${itemCode}.html" data-beacon="${beacon}"><img src="${imgSrc}"></a>`
  + `<a href="https://store.shopping.yahoo.co.jp/${storeId}/${itemCode}.html" data-beacon="_cl_link:title;itemcode:${itemCode};storeid:${storeId};tname:${title};prc:${price}"></a>`
}

function searchPageHtml(items: string[], totalCountText: string | null): string {
  const total = totalCountText ? `<p>${totalCountText}件</p>` : ''
  return `<html><body>${total}${items.join('')}</body></html>`
}

describe('YahooShoppingScraper.scrape 検索ページの一括抽出', () => {
  it('data-beacon属性から商品情報を抽出し、同一商品の重複リンク(img/title)を1件に統合する', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([fakeItemLink('zozo', '1', 'Item 1', 1000, 'https://example.com/1.jpg')], '1'),
      { status: 200 },
    )
    try {
      const scraper = new YahooShoppingScraper()
      const results = await scraper.scrape('https://shopping.yahoo.co.jp/search/nike/0/', { limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        sourceItemId: 'zozo_1',
        sourceUrl: 'https://store.shopping.yahoo.co.jp/zozo/1.html',
        title: 'Item 1',
        price: 1000,
        images: ['https://example.com/1.jpg'],
        sellerRatingCount: 100,
      })
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('パス末尾にページ番号を付与して2ページ目以降を取得する(既存ページ番号セグメントは正規化)', async () => {
    const requestedPaths: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const path = new URL(urlStr).pathname
      requestedPaths.push(path)
      if (path === '/search/nike/0/') {
        return new Response(searchPageHtml([fakeItemLink('s', 'a1', 'A1', 100, 'https://e.com/a1.jpg')], '2'), { status: 200 })
      }
      if (path === '/search/nike/0/2/') {
        return new Response(searchPageHtml([fakeItemLink('s', 'a2', 'A2', 200, 'https://e.com/a2.jpg')], '2'), { status: 200 })
      }
      return new Response(searchPageHtml([], '2'), { status: 200 })
    }
    try {
      const scraper = new YahooShoppingScraper()
      const results = await scraper.scrape('https://shopping.yahoo.co.jp/search/nike/0/', { limit: 600 })
      expect(results).toHaveLength(2)
      expect(requestedPaths).toEqual(['/search/nike/0/', '/search/nike/0/2/'])
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('既にページ番号付きのURLが渡されても正しく正規化してページ1から取得する', async () => {
    const requestedPaths: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      requestedPaths.push(new URL(urlStr).pathname)
      return new Response(searchPageHtml([fakeItemLink('s', 'b1', 'B1', 100, 'https://e.com/b1.jpg')], '1'), { status: 200 })
    }
    try {
      const scraper = new YahooShoppingScraper()
      // ユーザーが3ページ目のURLをそのまま貼り付けたケースを想定
      await scraper.scrape('https://shopping.yahoo.co.jp/search/nike/0/3/', { limit: 1 })
      expect(requestedPaths[0]).toBe('/search/nike/0/')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('空の結果が返ったページで終了する(総件数が取得できない場合のフォールバック)', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const path = new URL(urlStr).pathname
      requestCount += 1
      if (path === '/search/nike/0/') {
        return new Response(searchPageHtml([fakeItemLink('s', 'c1', 'C1', 100, 'https://e.com/c1.jpg')], null), { status: 200 })
      }
      return new Response(searchPageHtml([], null), { status: 200 })
    }
    try {
      const scraper = new YahooShoppingScraper()
      const results = await scraper.scrape('https://shopping.yahoo.co.jp/search/nike/0/', { limit: 600 })
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
      const scraper = new YahooShoppingScraper()
      await expect(scraper.scrape('https://shopping.yahoo.co.jp/search/nonexistent/0/')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
