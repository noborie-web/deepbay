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

describe('BrandOffScraper.matches', () => {
  it('単品ページURLにマッチする', () => {
    const scraper = new BrandOffScraper()
    expect(scraper.matches('https://www.brandoff-store.com/Form/Product/ProductDetail.aspx?shop=0&pid=999')).toBe(true)
  })

  it('検索結果ページURLにもマッチする', () => {
    const scraper = new BrandOffScraper()
    expect(scraper.matches('https://www.brandoff-store.com/Form/Product/ProductList.aspx?swd=nike')).toBe(true)
  })

  it('関係ないURLにはマッチしない', () => {
    const scraper = new BrandOffScraper()
    expect(scraper.matches('https://example.com/foo')).toBe(false)
  })
})

function fakeSearchItem(pid: string, title: string, price: number): string {
  return `<div class="product__item">
    <a href="/Form/Product/ProductDetail.aspx?shop=0&amp;pid=${pid}&amp;cat=1">
      <img src="/Contents/ProductImages/0/${pid}_L.jpg" alt="${title}">
    </a>
    <div class="product__item--name">${title}</div>
    <div class="product__price"><span class="product__price--numeric">&yen;${price}</span></div>
  </div>`
}

function searchPageHtml(items: string[], totalCountText: string | null): string {
  const total = totalCountText ? `<p>${totalCountText}件</p>` : ''
  return `<html><body>${total}${items.join('')}</body></html>`
}

describe('BrandOffScraper.scrape 検索ページの一括抽出', () => {
  it('検索結果カードから商品情報を正しく抽出し、画像を_LLサイズにアップサイズする', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([fakeSearchItem('1001', 'Item One', 1000)], '1'),
      { status: 200 },
    )
    try {
      const scraper = new BrandOffScraper()
      const results = await scraper.scrape('https://www.brandoff-store.com/Form/Product/ProductList.aspx?swd=test', { limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ sourceItemId: '1001', title: 'Item One', price: 1000 })
      expect(results[0].images[0]).toContain('_LL.jpg')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('1ページの件数が少なくても、まだ総件数に達していなければ次ページを取得し続ける', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const o = new URL(urlStr).searchParams.get('o') ?? '0'
      requestCount += 1
      if (o === '0') {
        return new Response(searchPageHtml([fakeSearchItem('2001', 'A1', 100), fakeSearchItem('2002', 'A2', 200)], '5'), { status: 200 })
      }
      if (o === '90') {
        return new Response(searchPageHtml([fakeSearchItem('2003', 'A3', 300), fakeSearchItem('2004', 'A4', 400), fakeSearchItem('2005', 'A5', 500)], '5'), { status: 200 })
      }
      return new Response(searchPageHtml([], '5'), { status: 200 })
    }
    try {
      const scraper = new BrandOffScraper()
      const results = await scraper.scrape('https://www.brandoff-store.com/Form/Product/ProductList.aspx?swd=test', { limit: 600 })
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
      const o = new URL(urlStr).searchParams.get('o') ?? '0'
      requestCount += 1
      if (o === '0') return new Response(searchPageHtml([fakeSearchItem('3001', 'C1', 100)], null), { status: 200 })
      return new Response(searchPageHtml([], null), { status: 200 })
    }
    try {
      const scraper = new BrandOffScraper()
      const results = await scraper.scrape('https://www.brandoff-store.com/Form/Product/ProductList.aspx?swd=test', { limit: 600 })
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
      const scraper = new BrandOffScraper()
      await expect(scraper.scrape('https://www.brandoff-store.com/Form/Product/ProductList.aspx?swd=nonexistent')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
