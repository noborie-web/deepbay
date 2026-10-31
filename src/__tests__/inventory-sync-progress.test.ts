import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockFetchActiveListingsBatch, mockFetchAllActiveListings, mockFetchListingsByItemIds, mockScanSellerList, mockUpsert } = vi.hoisted(() => ({
  mockFetchActiveListingsBatch: vi.fn(),
  mockFetchAllActiveListings: vi.fn(),
  mockFetchListingsByItemIds: vi.fn(),
  mockScanSellerList: vi.fn(),
  mockUpsert: vi.fn(),
}))

vi.mock('@/lib/ebay-inventory', () => ({
  fetchActiveListingsBatch: mockFetchActiveListingsBatch,
  fetchAllActiveListings: mockFetchAllActiveListings,
  fetchListingsByItemIds: mockFetchListingsByItemIds,
  scanSellerListByStartTime: mockScanSellerList,
  SELLER_LIST_MAX_RANGE_MS: 119 * 24 * 60 * 60 * 1000,
  EbayCallLimitError: class EbayCallLimitError extends Error {},
}))

// Kakehashiの出品ラベル(kakehashi_{商品UUID})
function kakehashiLabel(index: number): string {
  return `kakehashi_${index.toString(16).padStart(8, '0')}_0000_4000_8000_000000000000`
}

interface Listing { ebay_item_id: string; fetched_at: string }

// 在庫一覧・商品・走査位置だけを返す最小限のモック。
// listings は inventory_active_listings の中身(fetched_at 付き)。
function makeDb(listings: Listing[]) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'inventory_active_listings') {
        // .lt('fetched_at', x) / .gte('fetched_at', x) の絞り込みを再現する
        let rows = listings
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.not = () => chain
        // 商品レコードが失われた出品(product_id is null)の照会。
        // このモックの出品はすべて商品に紐付いているものとして扱う。
        chain.is = (column: string, value: unknown) => { if (column === 'product_id' && value === null) rows = []; return chain }
        chain.in = () => chain
        chain.like = () => chain
        chain.order = () => chain
        chain.lt = (_column: string, value: string) => { rows = rows.filter(r => r.fetched_at < value); return chain }
        chain.gte = (_column: string, value: string) => { rows = rows.filter(r => r.fetched_at >= value); return chain }
        chain.range = async (from: number) => ({ data: from === 0 ? rows : [], error: null })
        chain.upsert = mockUpsert
        chain.delete = () => ({ eq: () => ({ is: () => { const n = { not: () => n, then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }; return n } }) })
        return chain
      }
      if (table === 'products') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.not = () => chain
        chain.order = () => chain
        chain.update = () => chain
        chain.range = async () => ({ data: [], error: null })
        // 商品はすべて存在するものとして返す(保存対象になる)
        chain.in = async (column: string, values: string[]) => ({
          data: column === 'id' ? values.map(id => ({ id })) : [], error: null,
        })
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        return chain
      }
      if (table === 'extractions') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order']) chain[m] = () => chain
        chain.range = async () => ({ data: [], error: null })
        return chain
      }
      if (table === 'inventory_settings' || table === 'seller_accounts') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.update = () => chain
        chain.maybeSingle = async () => ({ data: { discovery_scanned_until: new Date().toISOString() }, error: null })
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        return chain
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  } as unknown as SupabaseClient
}

beforeEach(() => {
  mockFetchActiveListingsBatch.mockReset()
  mockFetchListingsByItemIds.mockReset().mockResolvedValue({ items: [], endedItemIds: [] })
  mockScanSellerList.mockReset().mockResolvedValue({ items: [], truncated: false, pagesFetched: 1, totalPages: 1 })
  mockUpsert.mockReset().mockResolvedValue({ error: null })
})

// 本番で確認した不具合(2026-10-31): 一覧取得が毎回時間切れして1件も取得できて
// いないのに、照会位置(カーソル)だけは進めていた。akebono-32 は4回/日すべてが
// この状態で、進めた分の出品は次の一巡まで確認されないまま飛ばされ続けていた。
describe('1件も確認できなかった同期', () => {
  const realNow = Date.now
  afterEach(() => { Date.now = realNow })

  it('カーソルを進めず、処理件数も0として返す', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 400 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))

    // 一覧取得が予算(60秒)を使い切って失敗する = 個別照会に回す時間も残らない
    let clock = realNow()
    Date.now = () => clock
    mockFetchActiveListingsBatch.mockImplementation(async () => {
      clock += 60_000
      throw new Error('eBay inventory sync timeout: exceeded 60000ms')
    })

    const result = await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      maxItemsPerRun: 100,
      cursorItemId: 'item-0099',
    })

    expect(result.bulkError).toBe('eBay inventory sync timeout: exceeded 60000ms')
    expect(result.matched).toBe(0)
    // ここが本題。進めると未確認の100件が次の一巡まで放置される
    expect(result.processed).toBe(0)
    expect(result.nextCursorItemId).toBe('item-0099')
  })
})

// 本番で確認した不具合(2026-10-31): 「直近に取得済みは再照会しない」は照会対象
// からは除いていたが、一覧取得で落ちてきた分はそのまま全件書き戻していたため
// 節約が打ち消されていた。miyabi-24 は照会対象614件に対し2,033件を保存し、
// 同期1回で250秒(全体予算200秒)を使って2人目の同期を押し出していた。
describe('直近に取得済みの出品', () => {
  it('一覧取得に載っていても書き戻さない', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const fresh = new Date(Date.now() - 60 * 1000).toISOString()
    const listings = [
      ...Array.from({ length: 300 }, (_, i) => ({ ebay_item_id: `stale-${String(i).padStart(4, '0')}`, fetched_at: old })),
      { ebay_item_id: 'fresh-1', fetched_at: fresh },
    ]

    // 一覧取得には古い出品も直近に取得した出品も載っている
    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [
        { ebayItemId: 'stale-0000', customLabel: kakehashiLabel(1), quantity: 1, quantitySold: 0, listingStatus: 'Active' },
        { ebayItemId: 'fresh-1', customLabel: kakehashiLabel(2), quantity: 1, quantitySold: 0, listingStatus: 'Active' },
      ],
      nextPage: null, totalPages: 1, lastFetchedPage: 1, truncated: false, ebayTotalPages: 1,
    })

    await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      skipFetchedWithinMs: 5 * 60 * 60 * 1000,
      maxItemsPerRun: 500,
    })

    const saved = (mockUpsert.mock.calls.flatMap(call => call[0] as Array<{ ebay_item_id: string }>))
      .map(row => row.ebay_item_id)
    expect(saved).toContain('stale-0000')
    expect(saved).not.toContain('fresh-1')
  })
})

// 本番で確認した不具合(2026-10-31): 一覧取得は残り時間を先頭のサイトから使い切る
// 作りなので、akebono-32(UK/AU)の2つ目のサイトは一度も取得されていなかった。
// 実行ごとに先頭を入れ替えて、どのサイトにも順番が回るようにする。
describe('複数サイトのセラー', () => {
  it('実行ごとに先頭のサイトを入れ替える', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 400 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))
    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [], nextPage: null, totalPages: 1, lastFetchedPage: 1, truncated: false, ebayTotalPages: 1,
    })

    const siteIdsFor = async (siteStartIndex: number) => {
      mockFetchActiveListingsBatch.mockClear()
      await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
        bulkRefresh: true, fetchTotalTimeoutMs: 60_000, maxItemsPerRun: 100,
        sellerSiteIds: ['UK', 'AU'], siteStartIndex,
      })
      return mockFetchActiveListingsBatch.mock.calls.map(call => (call[3] as { siteId?: string | null }).siteId)
    }

    expect((await siteIdsFor(0))[0]).toBe('UK')
    expect((await siteIdsFor(1))[0]).toBe('AU')
    // 時間帯(0〜3)が増えても2サイトを交互に先頭にする
    expect((await siteIdsFor(2))[0]).toBe('UK')
    expect((await siteIdsFor(3))[0]).toBe('AU')
  })
})
