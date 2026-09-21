import { afterEach, describe, expect, it, vi } from 'vitest'
import * as cheerio from 'cheerio'
import { YahooFleaScraper } from '../lib/scrapers/yahoo_flea'
import { findScraper } from '../lib/scrapers'

// 2026-09-21に実データで確認したYahoo!フリマの検索結果カード・商品ページの構造を模した最小フィクスチャ
function searchCard(opts: { id: string; title: string; price: number; sellerId: string; sold?: boolean }): string {
  return `<a data-cl-nofollow="on" data-cl-params="_cl_link:itm;_cl_position:0;catid:2419;rcconid:${opts.id};imgsz:0;itmcnd:0;price:${opts.price};noprcitm:0;sellerid:${opts.sellerId};pdctid:;" href="/item/${opts.id}">
  <div><img src="https://auc-pctr.c.yimg.jp/i/auctions.c.yimg.jp/images/${opts.id}.jpg?pri=s&amp;w=298&amp;h=298" alt="${opts.title}" />
  ${opts.sold ? '<img src="/icon_sold.svg" alt="sold" />' : ''}
  <p>${opts.price.toLocaleString()}<!-- -->円</p></div></a>`
}

const SEARCH_HTML = `<html><body>
${searchCard({ id: 'z688080634', title: 'ドラゴンボール ターレス GDR ゴッドレア', price: 2400, sellerId: 'p5796031' })}
${searchCard({ id: 'z688106704', title: 'ポケモンカード ホゲータex SAR', price: 1400, sellerId: 'p14693', sold: true })}
<a href="/item/z999999999" data-cl-params="_cl_link:reco;rcconid:z999999999;"><img alt="おすすめ商品" src="x.jpg" /></a>
</body></html>`

const ITEM_HTML = `<html><body>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Product',
  name: 'ドラゴンボールスーパーダイバーズ SDV12-011 ターレス GDR ゴッドレア',
  image: ['https://auctions.c.yimg.jp/images/1.jpg', 'https://auctions.c.yimg.jp/images/2.jpg'],
  url: 'https://paypayfleamarket.yahoo.co.jp/item/z688080634',
  description: 'ドラゴンボールスーパーダイバーズのカードです。\n【状態】目立った傷や汚れなし',
  offers: { '@type': 'Offer', priceCurrency: 'JPY', price: 2400, itemCondition: 'https://schema.org/UsedCondition', availability: 'https://schema.org/InStock' },
})}</script>
<h1>ドラゴンボールスーパーダイバーズ SDV12-011 ターレス GDR ゴッドレア</h1>
<p>出品日時：<span>2026年9月21日 12:22</span></p>
<h3>商品の情報</h3>
<table>
<tr><th>カテゴリ</th><td><a href="/category/2511">ゲーム、おもちゃ</a><a href="/category/2511/2420">トレーディングカード</a></td></tr>
<tr><th>商品の状態</th><td>目立った傷や汚れなし</td></tr>
<tr><th>発送までの日数</th><td>3〜7日で発送</td></tr>
<tr><th>商品ID</th><td>z688080634</td></tr>
</table>
<h3>出品者</h3><a href="/user/p5796031"><div>DB</div><span>（<!-- -->56<!-- -->）</span></a>
</body></html>`

describe('YahooFleaScraper', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('検索URL・商品URLの両方に対応し、findScraperで選ばれる', () => {
    expect(findScraper('https://paypayfleamarket.yahoo.co.jp/search/%E3%83%AC%E3%82%A2?open=1')?.siteKey).toBe('yahoo_flea')
    expect(findScraper('https://paypayfleamarket.yahoo.co.jp/item/z688080634')?.siteKey).toBe('yahoo_flea')
  })

  it('検索結果ページから商品カードを取り出し、売り切れバッジと出品者を判定する', () => {
    const products = new YahooFleaScraper().parseSearchPage(cheerio.load(SEARCH_HTML))
    expect(products).toHaveLength(2)
    expect(products[0]).toMatchObject({
      sourceUrl: 'https://paypayfleamarket.yahoo.co.jp/item/z688080634',
      sourceSite: 'yahoo_flea',
      sourceItemId: 'z688080634',
      title: 'ドラゴンボール ターレス GDR ゴッドレア',
      price: 2400,
      images: ['https://auc-pctr.c.yimg.jp/i/auctions.c.yimg.jp/images/z688080634.jpg'],
      availability: 'available',
      sellerUrl: 'https://paypayfleamarket.yahoo.co.jp/user/p5796031',
    })
    expect(products[1]).toMatchObject({ sourceItemId: 'z688106704', price: 1400, availability: 'sold_out' })
  })

  it('商品ページのld+jsonと「商品の情報」表から詳細を抽出する', () => {
    const product = new YahooFleaScraper().parse(cheerio.load(ITEM_HTML), 'https://paypayfleamarket.yahoo.co.jp/item/z688080634')
    expect(product).toMatchObject({
      sourceItemId: 'z688080634',
      title: 'ドラゴンボールスーパーダイバーズ SDV12-011 ターレス GDR ゴッドレア',
      price: 2400,
      images: ['https://auctions.c.yimg.jp/images/1.jpg', 'https://auctions.c.yimg.jp/images/2.jpg'],
      condition: '目立った傷や汚れなし',
      category: 'トレーディングカード',
      shippingDays: 3,
      sellerRatingCount: 56,
      availability: 'available',
      sellerUrl: 'https://paypayfleamarket.yahoo.co.jp/user/p5796031',
    })
    expect(product.description).toContain('ドラゴンボールスーパーダイバーズのカードです')
    expect(product.sourceUpdatedAt).toBe(new Date('2026-09-21T12:22:00+09:00').toISOString())
  })

  it('売り切れ商品は availability=sold_out になる', () => {
    const html = ITEM_HTML.replace('https://schema.org/InStock', 'https://schema.org/OutOfStock')
    const product = new YahooFleaScraper().parse(cheerio.load(html), 'https://paypayfleamarket.yahoo.co.jp/item/z688080634')
    expect(product.availability).toBe('sold_out')
  })

  it('検索抽出は販売中(open=1)を付与してページ送りし、商品ページで詳細を補完する', async () => {
    const urls: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/search/')) {
        const page = new URL(url).searchParams.get('page')
        return new Response(page === '1' ? SEARCH_HTML : '<html><body></body></html>', { status: 200 })
      }
      return new Response(ITEM_HTML, { status: 200 })
    }) as unknown as typeof fetch

    const products = await new YahooFleaScraper().scrape('https://paypayfleamarket.yahoo.co.jp/search/%E3%83%AC%E3%82%A2?minPrice=5000', { limit: 10 })
    expect(urls[0]).toContain('open=1')
    expect(urls[0]).toContain('page=1')
    expect(products).toHaveLength(2)
    expect(products[0].description).toContain('ドラゴンボール')
    expect(products[0].condition).toBe('目立った傷や汚れなし')
    expect(products[1].sourceItemId).toBe('z688106704')
  })
})
