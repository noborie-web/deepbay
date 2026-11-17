import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// 本番で確認した不具合(2026-10-25): メルカリを補完対象(ENRICHABLE_SITES)に
// 加えたのに、enrich-details のパーサー分岐にメルカリを足し忘れていた。
// メルカリのHTMLをヤフオクのパーサーに通していたため、画像0枚・説明文なしの
// 「空の成功」が返り、detail_enriched_at だけが付いて補完済みになっていた。
// 実データでは389件が検索結果のサムネ1枚・説明文なしのまま固定されていた。

const mocks = vi.hoisted(() => ({
  mercariScrape: vi.fn(),
  auctionParse: vi.fn(),
  fleaParse: vi.fn(),
  fetchWithRetry: vi.fn(),
  fetchShopProductDetails: vi.fn(),
  launchHeadlessBrowser: vi.fn(),
  browserClose: vi.fn(),
  callOrder: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/scrapers/mercari', () => ({
  MercariScraper: class { scrape = mocks.mercariScrape },
}))
vi.mock('@/lib/scrapers/yahoo_auction', () => ({
  YahooAuctionScraper: class { parse = mocks.auctionParse },
}))
vi.mock('@/lib/scrapers/yahoo_flea', () => ({
  YahooFleaScraper: class { parse = mocks.fleaParse },
  FLEA_DETAIL_PER_RUN: 20,
  FLEA_RATE_LIMIT_WINDOW_MS: 1000,
}))
vi.mock('@/lib/scrapers/mercari_shops', () => ({
  fetchShopProductDetails: mocks.fetchShopProductDetails,
}))
vi.mock('@/lib/scrapers/headless-browser', () => ({
  launchHeadlessBrowser: mocks.launchHeadlessBrowser,
}))
vi.mock('@/lib/scrapers/throttled-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scrapers/throttled-fetch')>()),
  fetchWithRetry: mocks.fetchWithRetry,
}))

import { runEnrichDetailsBatch } from '@/lib/enrich-details'

function detail(overrides: Record<string, unknown> = {}) {
  return {
    title: 'タイトル', description: '', images: [] as string[],
    condition: null, category: null, sellerRatingCount: null, sellerBadRatingCount: null,
    shippingDays: null, sourceUpdatedAt: null, sellerUrl: null, rawData: null,
    ...overrides,
  }
}

function makeDb() {
  mocks.updates.length = 0
  const products = {
    select: () => products,
    eq: () => products,
    is: () => products,
    in: () => products,
    or: () => products,
    not: () => products,
    order: () => products,
    maybeSingle: async () => ({ data: null, error: null }),
    limit: async () => ({ data: mocks.rows, error: null }),
    update: (values: Record<string, unknown>) => { mocks.updates.push(values); return products },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null, count: 0 }).then(resolve),
  }
  const settings = {
    select: () => settings,
    eq: () => settings,
    maybeSingle: async () => ({ data: null, error: null }),
  }
  return { from: (table: string) => (table === 'extraction_settings' ? settings : products) } as unknown as SupabaseClient
}

describe('補完のサイト分岐', () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY
    mocks.mercariScrape.mockReset()
    mocks.auctionParse.mockReset().mockReturnValue(detail())
    mocks.fleaParse.mockReset().mockReturnValue(detail())
    mocks.fetchWithRetry.mockReset().mockResolvedValue('<html></html>')
    mocks.callOrder.length = 0
    mocks.fetchShopProductDetails.mockReset().mockResolvedValue(new Map())
    mocks.browserClose.mockReset().mockResolvedValue(undefined)
    mocks.launchHeadlessBrowser.mockReset().mockResolvedValue({ close: mocks.browserClose })
    mocks.rows = [{
      id: 'p1', source_url: 'https://jp.mercari.com/item/m87277851844', source_site: 'mercari',
      original_description: null, ebay_description: null,
      original_images: ['https://static.mercdn.net/item/detail/webp/photos/m87277851844_1.jpg'],
      detail_attempts: 0, detail_retry_after: null,
    }]
  })

  it('メルカリ商品はメルカリの取得経路を使う(ヤフオクのパーサーに回さない)', async () => {
    mocks.mercariScrape.mockResolvedValue([detail({
      description: '商品の説明です',
      images: ['a_1.jpg', 'a_2.jpg', 'a_3.jpg', 'a_4.jpg'],
    })])

    const result = await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

    expect(mocks.mercariScrape).toHaveBeenCalledWith('https://jp.mercari.com/item/m87277851844', { limit: 1 })
    // メルカリのページをHTMLで取ってヤフオクのパーサーに通してはいけない
    expect(mocks.auctionParse).not.toHaveBeenCalled()
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled()
    expect(result.processed).toBe(1)
    // 4枚に差し替わる(サムネ1枚のままにしない)
    const saved = mocks.updates.find(u => 'original_images' in u)
    expect(saved?.original_images).toHaveLength(4)
    expect(saved?.detail_enriched_at).toBeTruthy()
  })

  it('説明文も画像も取れなかった結果は「補完済み」にせず再試行に回す', async () => {
    // パーサーの取り違えやページ構造の変更で中身を拾えていない状態
    mocks.mercariScrape.mockResolvedValue([detail()])

    const result = await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

    expect(result.processed).toBe(0)
    expect(result.failed).toBe(1)
    // detail_enriched_at を付けてしまうと二度と補完されない
    expect(mocks.updates.some(u => 'detail_enriched_at' in u)).toBe(false)
    expect(mocks.updates.some(u => 'detail_retry_after' in u)).toBe(true)
  })

  describe('メルカリShops', () => {
    // 本番で確認した不具合(2026-10-25): Shopsの商品URLは /shops/product/{id} で、
    // MercariScraper はこれを受け取れず毎回「Invalid Mercari URL」を投げていた。
    // 19件が補完できないまま再試行を繰り返し、補完cronが「いちばん古い抽出」を
    // 毎回この抽出に取られて、ほかの192件の補完まで止まっていた。
    beforeEach(() => {
      mocks.rows = [{
        id: 'p1', source_url: 'https://jp.mercari.com/shops/product/8f2R5vq5zTYKDvicmALP7P',
        source_site: 'mercari',
        original_description: null, ebay_description: null, original_images: [],
        detail_attempts: 0, detail_retry_after: null,
      }]
    })

    it('Shopsの商品はShops専用の取得経路を使う(通常のメルカリに回さない)', async () => {
      mocks.fetchShopProductDetails.mockResolvedValue(new Map([
        ['8f2R5vq5zTYKDvicmALP7P', detail({ description: 'Shopsの商品説明', images: ['s_1.jpg'], condition: '中古' })],
      ]))

      const result = await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

      expect(mocks.fetchShopProductDetails).toHaveBeenCalledTimes(1)
      expect(mocks.fetchShopProductDetails.mock.calls[0][0]).toEqual(['8f2R5vq5zTYKDvicmALP7P'])
      // 通常のメルカリの経路に回すと例外になる
      expect(mocks.mercariScrape).not.toHaveBeenCalled()
      expect(result.processed).toBe(1)
      expect(mocks.updates.find(u => 'original_description' in u)?.original_description).toBe('Shopsの商品説明')
    })

    it('この回のぶんをまとめて1回で取得する(1件ずつ取りに行かない)', async () => {
      mocks.rows = [1, 2, 3].map(n => ({
        id: `p${n}`, source_url: `https://jp.mercari.com/shops/product/shop${n}`,
        source_site: 'mercari',
        original_description: null, ebay_description: null, original_images: [],
        detail_attempts: 0, detail_retry_after: null,
      }))
      mocks.fetchShopProductDetails.mockResolvedValue(new Map(
        [1, 2, 3].map(n => [`shop${n}`, detail({ description: 'あり', images: ['s_1.jpg'] })]),
      ))

      const result = await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

      expect(mocks.fetchShopProductDetails).toHaveBeenCalledTimes(1)
      expect(mocks.fetchShopProductDetails.mock.calls[0][0]).toEqual(['shop1', 'shop2', 'shop3'])
      expect(result.processed).toBe(3)
    })

    it('ブラウザは使わない(本番でChromiumが必ず落ちていたため)', async () => {
      // 本番で確認した不具合(2026-11-15): Shopsの補完をヘッドレスブラウザで
      // 行っていたが、Vercel上ではほぼ必ず "browser.newPage: Target page,
      // context or browser has been closed" で落ち、5回失敗して諦めた商品が
      // 67件たまっていた。APIから取るようになったのでブラウザは起動しない。
      mocks.fetchShopProductDetails.mockResolvedValue(new Map([
        ['8f2R5vq5zTYKDvicmALP7P', detail({ description: 'Shopsの商品説明', images: ['s_1.jpg'] })],
      ]))

      await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

      expect(mocks.launchHeadlessBrowser).not.toHaveBeenCalled()
      // 既定ではブラウザでの再試行もしない
      expect(mocks.fetchShopProductDetails.mock.calls[0][1]?.browserFallback).toBeUndefined()
    })

    it('取得できなかった商品は「補完済み」にせず再試行に回す', async () => {
      mocks.fetchShopProductDetails.mockImplementation(async (ids: string[], options: { onFailure?: (id: string, error: string) => void }) => {
        for (const id of ids) options.onFailure?.(id, 'Shops API error: 500')
        return new Map()
      })

      const result = await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

      expect(result.processed).toBe(0)
      expect(result.failed).toBe(1)
      expect(mocks.updates.some(u => 'detail_enriched_at' in u)).toBe(false)
      expect(mocks.updates.find(u => 'detail_retry_after' in u)?.detail_error).toBe('Shops API error: 500')
    })

    it('出品が消えている(404)商品は再試行せず補完待ちから外す', async () => {
      mocks.fetchShopProductDetails.mockImplementation(async (ids: string[], options: { onFailure?: (id: string, error: string, gone: boolean) => void }) => {
        for (const id of ids) options.onFailure?.(id, 'Shops API error: 404', true)
        return new Map()
      })

      const result = await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

      expect(result.failed).toBe(1)
      // 再試行の予約はせず、補完待ちから外す
      expect(mocks.updates.some(u => 'detail_retry_after' in u && u.detail_retry_after)).toBe(false)
      expect(mocks.updates.some(u => 'detail_enriched_at' in u)).toBe(true)
    })

    it('通常のメルカリの取得より先にShopsを処理する', async () => {
      // 本番で確認した不具合(2026-10-25): Shopsの処理を通常のサイト取得の「あと」に
      // 置いていたため、一度も動かなかった。通常のメルカリの取得だけで時間予算
      // (42秒)を使い切るので、残り時間はいつも0だった。
      mocks.rows = [
        {
          id: 'shop1', source_url: 'https://jp.mercari.com/shops/product/shop1', source_site: 'mercari',
          original_description: null, ebay_description: null, original_images: [],
          detail_attempts: 0, detail_retry_after: null,
        },
        {
          id: 'item1', source_url: 'https://jp.mercari.com/item/m87277851844', source_site: 'mercari',
          original_description: null, ebay_description: null, original_images: [],
          detail_attempts: 0, detail_retry_after: null,
        },
      ]
      mocks.fetchShopProductDetails.mockImplementation(async () => {
        mocks.callOrder.push('shops')
        return new Map([['shop1', detail({ description: 'Shopsの説明', images: ['s_1.jpg'] })]])
      })
      mocks.mercariScrape.mockImplementation(async () => {
        mocks.callOrder.push('item')
        return [detail({ description: '通常の説明', images: ['i_1.jpg'] })]
      })

      const result = await runEnrichDetailsBatch(makeDb(), { id: 'user-1' }, 'extraction-1')

      expect(mocks.callOrder).toEqual(['shops', 'item'])
      expect(result.processed).toBe(2)
    })
  })
})
