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

  it('実際のカテゴリ番号(cat01, cat16, cat21等)を持つURLにもマッチする', () => {
    // "cat1"固定は実際の検索結果ページが返すリンク形式とは一致しない
    // (実データで確認済み: cat01, cat03, cat16, cat21 など2桁ゼロ埋め)。
    const scraper = new DigimartScraper()
    expect(scraper.urlPattern.test('https://www.digimart.net/cat01/shop5028/DS10715263/')).toBe(true)
    expect(scraper.urlPattern.test('https://www.digimart.net/cat16/shop4952/DS10712386/')).toBe(true)
    expect(scraper.urlPattern.test('https://www.digimart.net/cat21/shop4952/DS10712361/')).toBe(true)
  })

  it('itemPhotoAreaのギャラリーから複数の元画像を取得する(og:imageのみへのフォールバックより優先)', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="ブランド／型番／中古／&yen;10000／状態：A"/>
        <meta property="og:image" content="https://img.digimart.net/prdimg/m/ogfallback.jpg"/>
      </head><body>
        <p class="price">&yen;10000</p>
        <div class="itemPhotoArea">
          <a class="cbx" href="//img.digimart.net/prdimg/m/aa.jpg"></a>
          <a class="cbx" href="//img.digimart.net/prdimg/m/bb.jpg"></a>
        </div>
      </body></html>
    `
    const $ = cheerio.load(html)
    const scraper = new DigimartScraper()
    const product = scraper.parse($, 'https://www.digimart.net/cat01/shop1/DS1/')
    expect(product.images).toEqual([
      'https://img.digimart.net/prdimg/m/aa.jpg',
      'https://img.digimart.net/prdimg/m/bb.jpg',
    ])
  })
})

function fakeSearchCard(id: string, title: string, price: number, condition: string): string {
  return `<div class="itemSearchBlock" data-instrument-cd="${id}">
    <p class="ttl"><a href="/cat01/shop1/${id}/">${title}</a></p>
    <div class="pic"><img src="//img.digimart.net/prdimg/s/${id}.jpg"></div>
    <p class="price">&yen;${price}<span class="taxMark">税込</span></p>
    <p class="state">状態：<span class="tooltip">${condition}</span></p>
  </div>`
}

function searchPageHtml(cards: string[], totalCountText: string | null): string {
  const total = totalCountText ? `<p>該当 ${totalCountText}件</p>` : ''
  return `<html><body>${total}${cards.join('')}</body></html>`
}

describe('DigimartScraper.matches', () => {
  it('単品ページURLにマッチする', () => {
    const scraper = new DigimartScraper()
    expect(scraper.matches('https://www.digimart.net/cat01/shop5028/DS10715263/')).toBe(true)
  })

  it('検索結果ページURLにもマッチする', () => {
    const scraper = new DigimartScraper()
    expect(scraper.matches('https://www.digimart.net/search?keyword=Gibson')).toBe(true)
  })

  it('関係ないURLにはマッチしない', () => {
    const scraper = new DigimartScraper()
    expect(scraper.matches('https://example.com/foo')).toBe(false)
  })
})

describe('DigimartScraper.scrape 検索ページの一括抽出', () => {
  it('検索結果カードから商品情報を正しく抽出する', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(
      searchPageHtml([fakeSearchCard('DS1', 'Item 1', 1000, 'A'), fakeSearchCard('DS2', 'Item 2', 2000, 'B+')], '2'),
      { status: 200 },
    )
    try {
      const scraper = new DigimartScraper()
      const results = await scraper.scrape('https://www.digimart.net/search?keyword=test', { limit: 2 })
      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({ sourceItemId: 'DS1', title: 'Item 1', price: 1000, condition: 'A' })
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('1ページの件数が少なくても、まだ総件数に達していなければ次ページを取得し続ける', async () => {
    let requestCount = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      const page = new URL(urlStr).searchParams.get('currentPage') ?? '1'
      requestCount += 1
      if (page === '1') {
        return new Response(searchPageHtml([fakeSearchCard('P1', 'P1', 100, 'A'), fakeSearchCard('P2', 'P2', 200, 'A')], '5'), { status: 200 })
      }
      if (page === '2') {
        return new Response(searchPageHtml([fakeSearchCard('P3', 'P3', 300, 'A'), fakeSearchCard('P4', 'P4', 400, 'A'), fakeSearchCard('P5', 'P5', 500, 'A')], '5'), { status: 200 })
      }
      return new Response(searchPageHtml([], '5'), { status: 200 })
    }
    try {
      const scraper = new DigimartScraper()
      const results = await scraper.scrape('https://www.digimart.net/search?keyword=test', { limit: 600 })
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
      const page = new URL(urlStr).searchParams.get('currentPage') ?? '1'
      requestCount += 1
      if (page === '1') return new Response(searchPageHtml([fakeSearchCard('Q1', 'Q1', 100, 'A')], null), { status: 200 })
      return new Response(searchPageHtml([], null), { status: 200 })
    }
    try {
      const scraper = new DigimartScraper()
      const results = await scraper.scrape('https://www.digimart.net/search?keyword=test', { limit: 600 })
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
      const scraper = new DigimartScraper()
      await expect(scraper.scrape('https://www.digimart.net/search?keyword=nonexistent')).rejects.toThrow()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
