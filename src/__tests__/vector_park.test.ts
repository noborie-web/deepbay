import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { VectorParkScraper } from '../lib/scrapers/vector_park'

const SAMPLE_HTML = `
<html>
<head>
  <title>THE NORTH FACE Versatile Short | ベクトルパーク</title>
  <script type="application/ld+json">
  [{"@context":"https://schema.org/","@type":"Product","name":"THE NORTH FACE ザノースフェイス Versatile Short XL KHAKI","brand":{"@type":"Thing","name":"ザノースフェイス THE NORTH FACE"},"color":"カーキ","description":["品番：NB42335 着用シーズン：春夏秋"],"image":["https://image.vector-park.jp/images/item/1.jpg","https://image.vector-park.jp/images/item/2.jpg"],"offers":{"@type":"Offer","priceCurrency":"JPY","price":"3800","itemCondition":["状態ランクA","使用感が少ない中古品です"],"availability":"InStock","seller":{"@type":"Organization","name":"ベクトルパーク"}}}]
  </script>
</head>
<body></body>
</html>
`

describe('VectorParkScraper.parse', () => {
  it('extracts title from the Product JSON-LD', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new VectorParkScraper()
    const product = scraper.parse($, 'https://vector-park.jp/item/004-202608280393/')
    expect(product.title).toBe('THE NORTH FACE ザノースフェイス Versatile Short XL KHAKI')
  })

  it('extracts sourceItemId from the URL', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new VectorParkScraper()
    const product = scraper.parse($, 'https://vector-park.jp/item/004-202608280393/')
    expect(product.sourceItemId).toBe('004-202608280393')
  })

  it('extracts price from offers.price as a number', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new VectorParkScraper()
    const product = scraper.parse($, 'https://vector-park.jp/item/004-202608280393/')
    expect(product.price).toBe(3800)
  })

  it('extracts all images from the image array', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new VectorParkScraper()
    const product = scraper.parse($, 'https://vector-park.jp/item/004-202608280393/')
    expect(product.images).toEqual([
      'https://image.vector-park.jp/images/item/1.jpg',
      'https://image.vector-park.jp/images/item/2.jpg',
    ])
  })

  it('extracts the condition rank (first itemCondition entry)', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new VectorParkScraper()
    const product = scraper.parse($, 'https://vector-park.jp/item/004-202608280393/')
    expect(product.condition).toBe('状態ランクA')
  })

  it('uses the brand name as category', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new VectorParkScraper()
    const product = scraper.parse($, 'https://vector-park.jp/item/004-202608280393/')
    expect(product.category).toBe('ザノースフェイス THE NORTH FACE')
  })

  it('falls back to the <title> tag when no Product JSON-LD is present', () => {
    const html = `<html><head><title>フォールバック商品名 | ベクトルパーク</title></head><body></body></html>`
    const $ = cheerio.load(html)
    const scraper = new VectorParkScraper()
    const product = scraper.parse($, 'https://vector-park.jp/item/999-1/')
    expect(product.title).toBe('フォールバック商品名')
    expect(product.price).toBeNull()
    expect(product.images).toEqual([])
  })

  it('matches vector-park item URLs via urlPattern', () => {
    const scraper = new VectorParkScraper()
    expect(scraper.urlPattern.test('https://vector-park.jp/item/004-202608280393/')).toBe(true)
    expect(scraper.urlPattern.test('https://store.shopping.yahoo.co.jp/ebest/4545350055974.html')).toBe(false)
  })
})
