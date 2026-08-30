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

describe('VectorParkScraper.matches', () => {
  it('単品ページURLにマッチする', () => {
    const scraper = new VectorParkScraper()
    expect(scraper.matches('https://vector-park.jp/item/004-202608280393/')).toBe(true)
  })

  it('検索結果ページURLにもマッチする', () => {
    const scraper = new VectorParkScraper()
    expect(scraper.matches('https://vector-park.jp/list/?kw=nike')).toBe(true)
  })

  it('関係ないURLにはマッチしない', () => {
    const scraper = new VectorParkScraper()
    expect(scraper.matches('https://example.com/foo')).toBe(false)
  })
})

function fakeSearchItem(id: string, title: string, price: number, rank: string): string {
  return `<div class="item">
    <p class="item_img"><a href="/item/${id}/"><img src="https://image5.vector-park.jp/images/item/thumb/140x160/x/${id}_1.jpg?t=1" alt="${title}"></a></p>
    <p class="item_nm"><a href="/item/${id}/">省略されたタイトル…</a></p>
    <div class="item_pr"><p>￥${price}<span>(税込)</span></p></div>
    <ul class="item_icn"><li><img src="/contents/images/html_icons/rank/rank_${rank.toLowerCase()}.gif"></li></ul>
  </div>`
}

function searchPageHtml(items: string[], totalCountText: string | null): string {
  const total = totalCountText ? `<div class="page_link">1 - 60 / 全${totalCountText}件</div>` : ''
  return `<html><body>${total}<div class="list_area">${items.join('')}</div></body></html>`
}

describe('VectorParkScraper.scrape 検索ページの一括抽出', () => {
  it('検索結果カードから商品情報を正しく抽出する(画像alt属性を優先し、画像をアップサイズする)', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([fakeSearchItem('a-1', 'フルタイトル1', 1000, 'AB')], '1'),
      { status: 200 },
    )
    try {
      const scraper = new VectorParkScraper()
      const results = await scraper.scrape('https://vector-park.jp/list/?kw=test', { limit: 10 })
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        sourceItemId: 'a-1',
        title: 'フルタイトル1', // 省略されたitem_nmではなくimg altの全文
        price: 1000,
        condition: 'AB',
      })
      expect(results[0].images[0]).toContain('/images/item/original2/')
      expect(results[0].images[0]).toContain('//image.vector-park.jp/')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('1ページの件数が少なくても、まだ総件数に達していなければ次ページを取得し続ける', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const p = new URL(urlStr).searchParams.get('p') ?? '1'
      requestCount += 1
      if (p === '1') {
        return new Response(searchPageHtml([fakeSearchItem('b-1', 'B1', 100, 'A'), fakeSearchItem('b-2', 'B2', 200, 'A')], '5'), { status: 200 })
      }
      if (p === '2') {
        return new Response(searchPageHtml([fakeSearchItem('b-3', 'B3', 300, 'A'), fakeSearchItem('b-4', 'B4', 400, 'A'), fakeSearchItem('b-5', 'B5', 500, 'A')], '5'), { status: 200 })
      }
      return new Response(searchPageHtml([], '5'), { status: 200 })
    }
    try {
      const scraper = new VectorParkScraper()
      const results = await scraper.scrape('https://vector-park.jp/list/?kw=test', { limit: 600 })
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
      const p = new URL(urlStr).searchParams.get('p') ?? '1'
      requestCount += 1
      if (p === '1') return new Response(searchPageHtml([fakeSearchItem('c-1', 'C1', 100, 'A')], null), { status: 200 })
      return new Response(searchPageHtml([], null), { status: 200 })
    }
    try {
      const scraper = new VectorParkScraper()
      const results = await scraper.scrape('https://vector-park.jp/list/?kw=test', { limit: 600 })
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
      const scraper = new VectorParkScraper()
      await expect(scraper.scrape('https://vector-park.jp/list/?kw=nonexistent')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
