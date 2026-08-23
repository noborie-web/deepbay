import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { DigimartScraper } from '../lib/scrapers/digimart'

const SAMPLE_HTML = `
<html>
<head>
  <title>ROZEO GUITARS Ladybug-CB CM HB Cherry 【名古屋栄店】（中古/送料無料）【楽器検索デジマート】</title>
  <meta name="keywords" content="エレキギター,エレクトリックギター,セミアコ,ROZEO GUITARS" />
  <meta name="description" content="小ぶりな本格派国産セミアコ！" />
  <meta property="og:title" content="ROZEO GUITARS／Ladybug-CB CM HB Cherry 【名古屋栄店】／中古／&yen;218000／状態：B+"/>
  <meta property="og:image" content="https://img.digimart.net/prdimg/m/8a/4cb2a9cc2b51ead723e6d13504eae565790c18.jpg"/>
  <meta property="og:description" content="／イシバシ楽器／デジマート店／小ぶりな本格派国産セミアコ！"/>
</head>
<body>
  <p class="price">&yen;218000<span class="taxMark">&nbsp;税込</span></p>
  <p class="state">状態：<span class="tooltip">B+</span>&nbsp;<br /></p>
</body>
</html>
`

describe('DigimartScraper.parse', () => {
  it('extracts title (brand + model, excluding condition/price suffix)', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat1/shop1484/DS10704096/')
    expect(product.title).toBe('ROZEO GUITARS Ladybug-CB CM HB Cherry 【名古屋栄店】')
  })

  it('extracts sourceItemId from the URL', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat1/shop1484/DS10704096/')
    expect(product.sourceItemId).toBe('DS10704096')
  })

  it('extracts price as a number from the price element', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat1/shop1484/DS10704096/')
    expect(product.price).toBe(218000)
  })

  it('extracts condition rank', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat1/shop1484/DS10704096/')
    expect(product.condition).toBe('B+')
  })

  it('extracts category from the first keyword', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat1/shop1484/DS10704096/')
    expect(product.category).toBe('エレキギター')
  })

  it('extracts description and og:image', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat1/shop1484/DS10704096/')
    expect(product.description).toBe('小ぶりな本格派国産セミアコ！')
    expect(product.images).toEqual(['https://img.digimart.net/prdimg/m/8a/4cb2a9cc2b51ead723e6d13504eae565790c18.jpg'])
  })

  it('falls back to the first og:title segment when it has 3 or fewer parts', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="ブランドのみ"/>
      </head><body>
        <p class="price">&yen;5000</p>
      </body></html>
    `
    const $ = cheerio.load(html)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat1/shop1/DS999/')
    expect(product.title).toBe('ブランドのみ')
  })

  it('matches digimart product URLs via urlPattern', () => {
    const scraper = new DigimartScraper()
    expect(scraper.urlPattern.test('https://www.digimart.net/cat1/shop1484/DS10704096/')).toBe(true)
    expect(scraper.urlPattern.test('https://jp.mercari.com/item/m123')).toBe(false)
  })
})
