import { afterEach, describe, expect, it, vi } from 'vitest'

// 本番で確認した不具合(2026-11-15): メルカリShops商品の説明文・カテゴリ・
// 商品の状態をヘッドレスブラウザでしか取れないものとして実装していたが、
// Vercel上ではChromiumがほぼ必ず落ちており("browser.newPage: Target page,
// context or browser has been closed")、説明文が空のまま残った商品が76件
// たまっていた。Shopsの商品APIはDPoP署名だけで引けるので、ブラウザは要らない。
//
// 実データ(2026-11-15・カメラのキタムラ メルカリ店の商品)を元にした応答。
const SAMPLE = {
  name: '2JVKeQ7Jz6V5w6m9X2Ubxg',
  displayName: '【中古】 ニコン F 前期 アイレベル ボディ シルバー',
  price: '46150',
  productTags: [],
  updateTime: '2026-11-12T21:40:54Z',
  productDetail: {
    description: '■特記事項：オーバーホール済、現状渡し',
    photos: [
      'https://assets.mercari-shops-static.com/-/large/plain/a.jpg@jpg',
      'https://assets.mercari-shops-static.com/-/large/plain/b.jpg@jpg',
    ],
    condition: { displayName: '傷や汚れあり' },
    // APIは「深い階層→ルート」の順で返す
    categories: [
      { categoryId: '4032', displayName: '一眼レフカメラ(フィルム)' },
      { categoryId: '844', displayName: 'フィルムカメラ' },
      { categoryId: '97', displayName: 'カメラ' },
      { categoryId: '3888', displayName: 'テレビ・オーディオ・カメラ' },
    ],
    shop: { name: 'bMXvCzpyAckGiZsGSuxFra', shopStats: { reviewCount: '4903' } },
    shippingDuration: { minDays: 4, maxDays: 7 },
    auction: null,
  },
}

import { _productFromShopsApi, fetchShopProductDetails } from '../lib/scrapers/mercari_shops'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

describe('_productFromShopsApi', () => {
  it('説明文・画像・商品の状態・評価数・発送日数を取り出す', () => {
    const p = _productFromShopsApi(SAMPLE)
    expect(p.description).toBe('■特記事項：オーバーホール済、現状渡し')
    expect(p.images).toHaveLength(2)
    expect(p.condition).toBe('傷や汚れあり')
    expect(p.price).toBe(46150)
    expect(p.sellerRatingCount).toBe(4903)
    expect(p.shippingDays).toBe(4)
    expect(p.sourceUrl).toBe('https://jp.mercari.com/shops/product/2JVKeQ7Jz6V5w6m9X2Ubxg')
    expect(p.sourceUpdatedAt).toBe('2026-11-12T21:40:54Z')
  })

  it('カテゴリは最も詳細な階層にする(APIの並びはルートが最後)', () => {
    const p = _productFromShopsApi(SAMPLE)
    expect(p.category).toBe('一眼レフカメラ(フィルム)')
    expect(p.categoryPath).toEqual(['テレビ・オーディオ・カメラ', 'カメラ', 'フィルムカメラ', '一眼レフカメラ(フィルム)'])
  })

  it('売り切れはproductTagsから判定する', () => {
    expect(_productFromShopsApi(SAMPLE).availability).toBe('available')
    const soldOut = { ...SAMPLE, productTags: ['sold_out', 'out_of_stock'] }
    expect(_productFromShopsApi(soldOut).availability).toBe('sold_out')
  })

  it('オークション形式のShops商品はpriceTypeをauctionにする(抽出時の除外を効かせる)', () => {
    expect(_productFromShopsApi(SAMPLE).priceType).toBeUndefined()
    const auction = { ...SAMPLE, productDetail: { ...SAMPLE.productDetail, auction: { auctionId: 'x' } } }
    expect(_productFromShopsApi(auction).priceType).toBe('auction')
  })
})

describe('fetchShopProductDetails', () => {
  it('APIで取れた商品を商品IDごとに返す', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch
    const map = await fetchShopProductDetails(['2JVKeQ7Jz6V5w6m9X2Ubxg'])
    expect(map.get('2JVKeQ7Jz6V5w6m9X2Ubxg')?.description).toBe('■特記事項：オーバーホール済、現状渡し')
  })

  it('説明文も画像も無い応答は失敗として扱う(「空の成功」で補完済みにしない)', async () => {
    const empty = { name: 'x', displayName: 'タイトルだけ', price: '100', productDetail: {} }
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(empty), { status: 200 })) as typeof fetch
    const failures: string[] = []
    const map = await fetchShopProductDetails(['x'], { onFailure: (id) => failures.push(id) })
    expect(map.size).toBe(0)
    expect(failures).toEqual(['x'])
  })

  it('出品が消えている(404)ことを呼び出し側に伝える', async () => {
    // 本番で確認(2026-11-17): 11/15に抽出した67件のうち15件は、その後
    // 出品ごと消えていた(APIも商品ページも404)。再試行しても無駄なので
    // 補完待ちから外せるように gone を渡す。
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 5, message: 'product not found' }), { status: 404 })) as typeof fetch
    const seen: Array<{ id: string; gone: boolean }> = []
    await fetchShopProductDetails(['gone1'], { onFailure: (id, _error, gone) => seen.push({ id, gone }) })
    expect(seen).toEqual([{ id: 'gone1', gone: true }])
  })

  it('500などの一時的な失敗は gone にしない(再試行に回す)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch
    const seen: boolean[] = []
    await fetchShopProductDetails(['x'], { onFailure: (_id, _error, gone) => seen.push(gone) })
    expect(seen).toEqual([false])
  })

  it('既定ではブラウザでの再試行をしない(本番でChromiumが必ず落ちるため)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch
    const map = await fetchShopProductDetails(['a', 'b'])
    expect(map.size).toBe(0)
  })
})

describe('fetchShopProductDetails ブラウザでの再試行', () => {
  // 以前はShops商品1件ごとにブラウザを起動していた(起動だけでサーバーレス
  // では十数秒)。再試行として残すぶんは数件ごとに使い回す。ただし同じ
  // ブラウザを使い続けると数件でdisconnectedになる実績があるため、
  // 一定件数ごとに起動し直す。
  const PAGE_HTML = `<html><body>
    <div data-testid="display-name">ブラウザで取れた商品</div>
    <div data-testid="description">ブラウザ経由の説明文</div>
    <div data-testid="image-0"><img src="https://assets.mercari-shops-static.com/1.jpg"/></div>
  </body></html>`

  it('APIで取れなかったぶんだけ、ブラウザを使い回して取り直す', async () => {
    vi.resetModules()
    const launchHeadlessBrowser = vi.fn(async () => ({
      newPage: async () => ({
        goto: async () => {},
        waitForSelector: async () => {},
        content: async () => PAGE_HTML,
        close: async () => {},
      }),
      close: async () => {},
    }))
    vi.doMock('../lib/scrapers/headless-browser', () => ({ launchHeadlessBrowser }))

    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch
    try {
      const mod = await import('../lib/scrapers/mercari_shops')
      const ids = ['a', 'b', 'c', 'd', 'e', 'f']
      const map = await mod.fetchShopProductDetails(ids, { browserFallback: true })

      expect(map.size).toBe(6)
      expect(map.get('a')?.description).toBe('ブラウザ経由の説明文')
      // 6件を1件ごとに起動していた頃は6回。5件ごとに起動し直すので2回。
      expect(launchHeadlessBrowser).toHaveBeenCalledTimes(2)
    } finally {
      globalThis.fetch = origFetch
      vi.doUnmock('../lib/scrapers/headless-browser')
      vi.resetModules()
    }
  })
})
