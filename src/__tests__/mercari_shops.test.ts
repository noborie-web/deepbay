import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { MercariShopsScraper } from '../lib/scrapers/mercari_shops'

const SAMPLE_HTML = `
<html>
<head>
  <meta property="og:title" content="フォールバック商品名 - メルカリ"/>
  <meta property="og:description" content="フォールバック説明文"/>
  <meta property="og:image" content="https://assets.mercari-shops-static.com/fallback.jpg"/>
</head>
<body>
  <div data-testid="display-name">愛媛県産コシヒカリ20kg</div>
  <div data-testid="product-price">¥9,980</div>
  <div data-testid="description">新米の愛媛県産コシヒカリです。送料無料。</div>
  <div data-testid="商品の状態">新品、未使用</div>
  <div data-testid="product-detail-category">
    <a href="/shops/category/1">食品</a>
    <a href="/shops/category/2">米・雑穀・粉類</a>
  </div>
  <div data-testid="image-0"><img src="https://assets.mercari-shops-static.com/1.jpg"/></div>
  <div data-testid="image-1"><img src="https://assets.mercari-shops-static.com/2.jpg"/></div>
  <div data-testid="image-2"><img src="https://assets.mercari-shops-static.com/3.jpg"/></div>
</body>
</html>
`

describe('MercariShopsScraper.parse', () => {
  it('extracts title from display-name testid', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/vpw2oNgfkCfiJ5Zuhre93a')
    expect(product.title).toBe('愛媛県産コシヒカリ20kg')
  })

  it('extracts sourceItemId from the URL', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/vpw2oNgfkCfiJ5Zuhre93a')
    expect(product.sourceItemId).toBe('vpw2oNgfkCfiJ5Zuhre93a')
  })

  it('extracts price as a number from product-price testid', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/vpw2oNgfkCfiJ5Zuhre93a')
    expect(product.price).toBe(9980)
  })

  it('extracts description from description testid', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/vpw2oNgfkCfiJ5Zuhre93a')
    expect(product.description).toBe('新米の愛媛県産コシヒカリです。送料無料。')
  })

  it('extracts condition from the 商品の状態 testid', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/vpw2oNgfkCfiJ5Zuhre93a')
    expect(product.condition).toBe('新品、未使用')
  })

  it('uses the most specific (last) breadcrumb level as category', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/vpw2oNgfkCfiJ5Zuhre93a')
    expect(product.category).toBe('米・雑穀・粉類')
  })

  it('extracts all numbered image testids in order', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/vpw2oNgfkCfiJ5Zuhre93a')
    expect(product.images).toEqual([
      'https://assets.mercari-shops-static.com/1.jpg',
      'https://assets.mercari-shops-static.com/2.jpg',
      'https://assets.mercari-shops-static.com/3.jpg',
    ])
  })

  it('falls back to og:title/og:description/og:image when testids are missing', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="フォールバック商品名 - メルカリ"/>
        <meta property="og:description" content="フォールバック説明文"/>
        <meta property="og:image" content="https://assets.mercari-shops-static.com/fallback.jpg"/>
      </head><body></body></html>
    `
    const $ = cheerio.load(html)
    const scraper = new MercariShopsScraper()
    const product = scraper.parse($, 'https://jp.mercari.com/shops/product/abc123')
    expect(product.title).toBe('フォールバック商品名')
    expect(product.description).toBe('フォールバック説明文')
    expect(product.images).toEqual(['https://assets.mercari-shops-static.com/fallback.jpg'])
    expect(product.price).toBeNull()
    expect(product.condition).toBeNull()
  })

  it('matches jp.mercari.com/shops/product URLs via urlPattern', () => {
    const scraper = new MercariShopsScraper()
    expect(scraper.urlPattern.test('https://jp.mercari.com/shops/product/2JKpMCyG4rfKh7hRqtW8rv')).toBe(true)
    expect(scraper.urlPattern.test('https://jp.mercari.com/item/m12345678')).toBe(false)
    expect(scraper.urlPattern.test('https://www.trefac.jp/store/1/c1/')).toBe(false)
  })
})
