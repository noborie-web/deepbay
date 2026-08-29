import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import { BrandOffScraper } from '../lib/scrapers/brandoff'

const SAMPLE_HTML = `
<html>
<head>
  <title>エルメス(HERMES)エルメス ロデオPM ブルーグラシエ カリー ルージュアッシュ チャーム アクセサリー レディース｜2101220102241｜【公式】新品中古どちらもブランドの通販ならブランドオフ・オンラインストア| BRAND OFF Online Store</title>
</head>
<body>
  <h2 class="product__desc--name">
    エルメス ロデオPM ブルーグラシエ カリー ルージュアッシュ チャーム アクセサリー レディース
  </h2>
  <div class="product__price--item">
    <span class="product__price--numeric product__price--numeric-nomal">
      &#165;70,000
    </span>
  </div>
  <dl>
    <dt>商品状態：</dt>
    <dd class="">
      <img src="/Contents/ThemeImage/common/cicon/cicon_05.svg" width="54" height="18" alt="RANK A" loading="lazy">
    </dd>
  </dl>
  <img src="/Contents/ProductImages/0/2101220102241_M.jpg">
  <img src="/Contents/ProductImages/0/2101220102241_LL.jpg">
</body>
</html>
`

describe('BrandOffScraper.parse', () => {
  it('extracts title from the product name heading', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new BrandOffScraper()
    const product = scraper.parse($, 'https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=2101220102241&cat=115')
    expect(product.title).toBe('エルメス ロデオPM ブルーグラシエ カリー ルージュアッシュ チャーム アクセサリー レディース')
  })

  it('extracts sourceItemId (pid) from the URL', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new BrandOffScraper()
    const product = scraper.parse($, 'https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=2101220102241&cat=115')
    expect(product.sourceItemId).toBe('2101220102241')
  })

  it('extracts price from the numeric price span', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new BrandOffScraper()
    const product = scraper.parse($, 'https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=2101220102241&cat=115')
    expect(product.price).toBe(70000)
  })

  it('extracts the condition rank from the image alt text', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new BrandOffScraper()
    const product = scraper.parse($, 'https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=2101220102241&cat=115')
    expect(product.condition).toBe('RANK A')
  })

  it('extracts only the large (_LL) product image, deduplicated', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new BrandOffScraper()
    const product = scraper.parse($, 'https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=2101220102241&cat=115')
    expect(product.images).toEqual([
      'https://www.brandoff-store.com/Contents/ProductImages/0/2101220102241_LL.jpg',
    ])
  })

  it('extracts the brand name (before the parenthesis) from <title> as category', () => {
    const $ = cheerio.load(SAMPLE_HTML)
    const scraper = new BrandOffScraper()
    const product = scraper.parse($, 'https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=2101220102241&cat=115')
    expect(product.category).toBe('エルメス')
  })

  it('matches brandoff-store.com product detail URLs via urlPattern', () => {
    const scraper = new BrandOffScraper()
    expect(scraper.urlPattern.test('https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=2101220102241&cat=115')).toBe(true)
    expect(scraper.urlPattern.test('https://www.trefac.jp/store/1003007257179003/c4330114/')).toBe(false)
  })

  it('returns nulls gracefully when expected elements are missing', () => {
    const html = `<html><head><title>フォールバック(FALLBACK)｜999｜BRAND OFF Online Store</title></head><body></body></html>`
    const $ = cheerio.load(html)
    const scraper = new BrandOffScraper()
    const product = scraper.parse($, 'https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=999')
    expect(product.title).toBe('フォールバック(FALLBACK)')
    expect(product.price).toBeNull()
    expect(product.condition).toBeNull()
    expect(product.images).toEqual([])
  })
})
