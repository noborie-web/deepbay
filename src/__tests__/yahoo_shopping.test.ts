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
