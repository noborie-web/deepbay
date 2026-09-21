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

// ユーザー要望: ヤフオクの検索URLを指定したとき、同じ条件でYahoo!フリマも
// 検索して合算する(ヤフオク検索にフリマ出品が混ざるのは一部利用者向けの
// 表示で、サーバー側の取得では含まれないため)。
describe('buildYahooFleaSearchUrlFromAuction', () => {
  // 2026-09-21に実データで確認したフリマのカテゴリ階層を模したフェッチャ
  const tree: Record<number, Array<{ id: number; name: string }>> = {
    1: [{ id: 13457, name: 'ファッション' }, { id: 2511, name: 'ゲーム、おもちゃ' }],
    2511: [{ id: 2161, name: 'テレビゲーム' }, { id: 2119, name: 'おもちゃ' }],
    2161: [{ id: 100, name: 'Switch' }, { id: 16899, name: '旧機種' }],
    16899: [{ id: 16900, name: 'スーパーファミコン' }, { id: 16904, name: 'ファミコン' }],
    16904: [{ id: 16908, name: 'ソフト' }, { id: 16905, name: '本体' }],
  }
  const fetcher = async (id: number) => tree[id] ?? []
  const auctionUrl = 'https://auctions.yahoo.co.jp/search/search?min=5000&max=50000&price_type=currentprice&p=%E3%83%AC%E3%82%A2&auccat=2084005190&va=%E3%83%AC%E3%82%A2&fixed=1&istatus=1%2C2&pstagefree=1&b=1&n=100'

  it('キーワード・価格帯・状態を引き継ぎ、カテゴリ階層を名前で辿ってフリマのカテゴリIDに対応付ける', async () => {
    const { buildYahooFleaSearchUrlFromAuction } = await import('../lib/scrapers/yahoo_flea')
    const url = await buildYahooFleaSearchUrlFromAuction(
      auctionUrl,
      ['すべてのカテゴリ', 'おもちゃ、ゲーム', 'ゲーム', 'テレビゲーム', 'ファミコン', 'タイトル'],
      fetcher,
    )
    const u = new URL(url!)
    expect(decodeURIComponent(u.pathname)).toBe('/search/レア')
    expect(u.searchParams.get('open')).toBe('1')
    expect(u.searchParams.get('minPrice')).toBe('5000')
    expect(u.searchParams.get('maxPrice')).toBe('50000')
    expect(u.searchParams.get('conditions')).toBe('NEW,USED10,USED20,USED40,USED60,USED80')
    // おもちゃ、ゲーム→ゲーム、おもちゃ(語順違い) / ゲーム(フリマに無い階層は読み飛ばす) /
    // ファミコン(旧機種の下=孫) / タイトル→ソフト(別名)
    expect(u.searchParams.get('categoryIds')).toBe('16908')
  })

  it('カテゴリを対応付けできない場合は具体的な階層名をキーワードに補う', async () => {
    const { buildYahooFleaSearchUrlFromAuction } = await import('../lib/scrapers/yahoo_flea')
    const url = await buildYahooFleaSearchUrlFromAuction(auctionUrl, ['すべてのカテゴリ', '楽器', 'ギター', 'タイトル'], async () => [])
    const u = new URL(url!)
    expect(decodeURIComponent(u.pathname)).toBe('/search/レア ギター')
    expect(u.searchParams.has('categoryIds')).toBe(false)
  })

  it('キーワードが無いURLは変換しない', async () => {
    const { buildYahooFleaSearchUrlFromAuction } = await import('../lib/scrapers/yahoo_flea')
    expect(await buildYahooFleaSearchUrlFromAuction('https://auctions.yahoo.co.jp/search/search?auccat=1', [], fetcher)).toBeNull()
  })
})

describe('YahooAuctionScraper + Yahoo!フリマ合算', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  const AUCTION_SEARCH_HTML = `<html><body>
<div class="Result__header">2件</div>
<div class="CategoryTree"><a class="CategoryTree__link">すべてのカテゴリ</a><a class="CategoryTree__link">おもちゃ、ゲーム</a><a class="CategoryTree__link">ファミコン</a></div>
<a class="Product__imageLink" data-auction-id="g111" data-auction-title="オークション商品A" data-auction-price="6000" data-auction-img="https://a.jpg?w=300&h=300"></a>
<a class="Product__imageLink" data-auction-id="u222" data-auction-title="オークション商品B" data-auction-price="7000" data-auction-img="https://b.jpg?w=300&h=300"></a>
</body></html>`

  it('includeYahooFlea のときフリマ側も検索し、フリマ出品だけを合算する(ヤフオク定額の重複は除く)', async () => {
    const { YahooAuctionScraper } = await import('../lib/scrapers/yahoo_auction')
    const fetched: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      fetched.push(url)
      if (url.includes('auctions.yahoo.co.jp/search/search')) return new Response(AUCTION_SEARCH_HTML, { status: 200 })
      if (url.includes('/api/v1/categories/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('paypayfleamarket.yahoo.co.jp/search/')) {
        const page = new URL(url).searchParams.get('page')
        if (page !== '1') return new Response('<html><body></body></html>', { status: 200 })
        return new Response(`<html><body>
${searchCard({ id: 'z333', title: 'フリマ商品C', price: 8000, sellerId: 'p1' })}
${searchCard({ id: 'g111', title: 'オークション商品A(フリマ側にも表示)', price: 6000, sellerId: 'p2' })}
</body></html>`, { status: 200 })
      }
      return new Response(ITEM_HTML, { status: 200 })
    }) as unknown as typeof fetch

    const products = await new YahooAuctionScraper().scrape(
      'https://auctions.yahoo.co.jp/search/search?p=%E3%83%AC%E3%82%A2&min=5000&max=50000&fixed=1',
      { limit: 100, includeYahooFlea: true, skipDetailEnrichment: true },
    )
    const fleaSearch = fetched.find(u => u.includes('paypayfleamarket.yahoo.co.jp/search/'))!
    expect(decodeURIComponent(new URL(fleaSearch).pathname)).toBe('/search/レア ファミコン')
    expect(products.map(p => [p.sourceItemId, p.sourceSite])).toEqual([
      ['g111', 'yahoo_auction'], ['u222', 'yahoo_auction'], ['z333', 'yahoo_flea'],
    ])
  })

  it('includeYahooFlea が無ければフリマ側を検索しない', async () => {
    const { YahooAuctionScraper } = await import('../lib/scrapers/yahoo_auction')
    const fetched: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      fetched.push(url)
      return new Response(AUCTION_SEARCH_HTML, { status: 200 })
    }) as unknown as typeof fetch
    const products = await new YahooAuctionScraper().scrape('https://auctions.yahoo.co.jp/search/search?p=%E3%83%AC%E3%82%A2', { limit: 100 })
    expect(products).toHaveLength(2)
    expect(fetched.some(u => u.includes('paypayfleamarket'))).toBe(false)
  })
})
