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
