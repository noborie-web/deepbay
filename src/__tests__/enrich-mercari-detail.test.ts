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
})
