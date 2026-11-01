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
        // 削除系は絞り込みの順番が呼び出し元によって違うので、何度でも繋げる
        chain.delete = () => {
          const n: Record<string, unknown> = {}
          for (const m of ['eq', 'is', 'not', 'in', 'like', 'lt']) n[m] = () => n
          n.then = (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r)
          return n
        }
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

// 本番で確認した不具合(2026-11-01): akebono-32 のeBayアカウントには他ツールの
// 出品が10,000件以上あり、Kakehashiの出品1,023件はページ上限(50ページ)より
// 後ろにいる。一覧取得は成功する(10,386件)のに照会対象は1件も含まれず、しかも
// 取得予算を使い切るので個別照会のフォールバックも飛ばされ、processed:0 が
// 2日以上続いていた(979件が10/30から未確認)。
// ユーザー指示(2026-11-01): このセラーもKakehashiの出品のみ管理する。
describe('出品数がページ上限を超えているアカウント', () => {
  it('一覧取得をやめ、把握している出品を個別照会する', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 1023 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))

    // 1ページ目で上限超えと分かり、取得結果なしで返る
    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [], nextPage: null, totalPages: 50, lastFetchedPage: 1,
      truncated: true, ebayTotalPages: 142, stoppedAtPageCap: true,
    })
    mockFetchListingsByItemIds.mockImplementation(async (_tokens: unknown, ids: string[]) => ({
      items: ids.map(id => ({ ebayItemId: id, customLabel: kakehashiLabel(1), quantity: 1, quantitySold: 0, listingStatus: 'Active' })),
      endedItemIds: [],
    }))

    const result = await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      maxItemsPerRun: 182,
      maxItemLookupsPerRun: 500,
    })

    // 一覧取得は使わず、見送った理由を残す
    expect(result.bulkSkipped).toBe('exceeds_page_cap')
    expect(result.bulkItems).toBeUndefined()
    // 個別照会に回っている(ここが本題。修正前は processed:0 のままだった)
    expect(mockFetchListingsByItemIds).toHaveBeenCalledTimes(1)
    // 一覧取得前提の配分(182件)ではなく、個別照会用の枠(500件)を使う
    expect(mockFetchListingsByItemIds.mock.calls[0][1]).toHaveLength(500)
    expect(result.processed).toBe(500)
    expect(result.nextCursorItemId).toBe('item-0499')
  })

  it('上限を超えていなければ一覧取得をそのまま使う', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 400 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))

    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [{ ebayItemId: 'item-0000', customLabel: kakehashiLabel(1), quantity: 1, quantitySold: 0, listingStatus: 'Active' }],
      nextPage: null, totalPages: 1, lastFetchedPage: 1, truncated: false, ebayTotalPages: 1,
    })

    const result = await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      maxItemsPerRun: 182,
      maxItemLookupsPerRun: 500,
    })

    expect(result.bulkSkipped).toBeUndefined()
    expect(result.bulkItems).toBe(1)
    // 一覧取得を使うセラーの照会枠は従来どおり(個別照会の枠に広げない)
    expect(result.processed).toBe(182)
  })
})

// 本番で起きた事故(2026-10-24): 個別照会が1日3,520回に達してeBayの上限(5,000回)を
// 超え、価格改定1,282件のうち954件が失敗した。同期には事前の残量確認が無く、
// eBayが上限エラーを返すまで送り続ける作りだった。
// #328 で一覧取得が使えないセラーを個別照会に回したため、Kakehashiの管理出品
// 4,493件がすべて1件1回の照会になり、618+500件/回 × 4回 = 4,472回/日 に達する。
// 送る前に残量で頭を抑える。
describe('eBayの1日の残り回数', () => {
  const bulkUnusable = {
    items: [], nextPage: null, totalPages: 50, lastFetchedPage: 1,
    truncated: true, ebayTotalPages: 1515, stoppedAtPageCap: true,
  }

  beforeEach(() => {
    mockFetchListingsByItemIds.mockReset().mockImplementation(async (_tokens: unknown, ids: string[]) => ({
      items: ids.map(id => ({ ebayItemId: id })), endedItemIds: [],
    }))
  })

  it('残量より多くは照会せず、続きはカーソルに残す', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 3470 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))
    mockFetchActiveListingsBatch.mockResolvedValue(bulkUnusable)

    const result = await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      maxItemsPerRun: 618,
      maxItemLookupsPerRun: 500,
      maxEbayCallsThisRun: 120,
    })

    expect(result.callBudgetLimited).toBe(true)
    expect(mockFetchListingsByItemIds.mock.calls[0][1]).toHaveLength(120)
    expect(result.processed).toBe(120)
    // 残りは次回へ(飛ばさない)
    expect(result.nextCursorItemId).toBe('item-0119')
  })

  it('残量が0なら1件も照会しない', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 3470 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))
    mockFetchActiveListingsBatch.mockResolvedValue(bulkUnusable)

    const result = await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      maxItemsPerRun: 618,
      maxItemLookupsPerRun: 500,
      maxEbayCallsThisRun: 0,
    })

    // ここが本題。残量0で「上限なし」に倒すと全件送信になって事故が大きくなる
    expect(mockFetchListingsByItemIds).not.toHaveBeenCalled()
    expect(result.processed).toBe(0)
    expect(result.callBudgetLimited).toBe(true)
  })

  it('残量が足りていれば従来どおりの件数を照会する', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 3470 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))
    mockFetchActiveListingsBatch.mockResolvedValue(bulkUnusable)

    const result = await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      maxItemsPerRun: 618,
      maxItemLookupsPerRun: 500,
      maxEbayCallsThisRun: 4_000,
    })

    expect(result.callBudgetLimited).toBeUndefined()
    expect(result.processed).toBe(618)
  })
})

// 本番で確認した問題(2026-11-01): discovery_truncated が真偽値だけだったため、
// akebono-32 の true を見て新規出品を取りこぼしていると判断した。実際には
// 読み切れた回もあり、打ち切った回はカーソルを進めず次回やり直していたので
// 取りこぼしは無かった。何ページ中何ページ読めたかを残して測れるようにする。
describe('新規出品の走査', () => {
  it('読めたページ数と総ページ数を返す', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [], nextPage: null, totalPages: 1, lastFetchedPage: 1, truncated: false, ebayTotalPages: 1,
    })
    // UKは全部読めたが、AUは8ページ中2ページで時間切れ
    mockScanSellerList
      .mockReset()
      .mockResolvedValueOnce({ items: [], truncated: false, pagesFetched: 3, totalPages: 3 })
      .mockResolvedValueOnce({ items: [], truncated: true, pagesFetched: 2, totalPages: 8 })

    const result = await syncKnownInventoryListings(makeDb([]), 'user-1', 'token', {
      sellerAccountId: 'seller-b',
      sellerSiteIds: ['UK', 'AU'],
      discoveryTimeBudgetMs: 30_000,
    })

    expect(result.discoveryTruncated).toBe(true)
    // 「11ページ中5ページ」と分かる(真偽値だけでは量が分からない)
    expect(result.discoveryPagesFetched).toBe(5)
    expect(result.discoveryTotalPages).toBe(11)
  })

  it('読み切れた回は truncated を立てない', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [], nextPage: null, totalPages: 1, lastFetchedPage: 1, truncated: false, ebayTotalPages: 1,
    })
    mockScanSellerList.mockReset().mockResolvedValue({ items: [], truncated: false, pagesFetched: 2, totalPages: 2 })

    const result = await syncKnownInventoryListings(makeDb([]), 'user-1', 'token', {
      sellerAccountId: 'seller-a',
      sellerSiteIds: ['US'],
      discoveryTimeBudgetMs: 30_000,
    })

    expect(result.discoveryTruncated).toBe(false)
    // 走査位置が無いので3日分(1日ずつ3区間)を読む。2ページ×3区間=6ページ。
    expect(result.discoveryPagesFetched).toBe(6)
    expect(result.discoveryTotalPages).toBe(6)
    expect(mockScanSellerList).toHaveBeenCalledTimes(3)
  })
})

// 本番で確認した不具合(2026-11-01): #328 で一覧取得をやめて個別照会に切り替わった
// miyabi-24 が、618件を60秒で引き切れずに時間切れとなり、例外が同期全体を落として
// いた(result_summary が空のまま failed)。取得できていた分まで捨てられていた。
describe('個別照会が時間切れした同期', () => {
  it('取得できた分は保存し、カーソルは確認できたところまで進める', async () => {
    const { syncKnownInventoryListings } = await import('@/lib/inventory-sync')
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listings = Array.from({ length: 600 }, (_, i) => ({ ebay_item_id: `item-${String(i).padStart(4, '0')}`, fetched_at: old }))

    // 一覧取得は使えないアカウント(ページ上限超え)
    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [], nextPage: null, totalPages: 50, lastFetchedPage: 1,
      truncated: true, ebayTotalPages: 1515, stoppedAtPageCap: true,
    })
    // 500件のうち3件だけ引けたところで時間切れ
    mockFetchListingsByItemIds.mockReset().mockImplementation(async (_tokens: unknown, ids: string[]) => ({
      items: ids.slice(0, 3).map((id, i) => ({
        ebayItemId: id, customLabel: kakehashiLabel(i + 1),
        quantity: 1, quantitySold: 0, listingStatus: 'Active',
      })),
      endedItemIds: [],
      truncated: true,
    }))

    const result = await syncKnownInventoryListings(makeDb(listings), 'user-1', 'token', {
      bulkRefresh: true,
      fetchTotalTimeoutMs: 60_000,
      maxItemsPerRun: 500,
      maxItemLookupsPerRun: 500,
    })

    // 例外にならず、取れた分で完了する
    expect(result.matched).toBeGreaterThan(0)
    // 確認できた3件ぶんだけ進める。500件すべて照会した体で進めると、
    // 残り497件が次の一巡まで確認されない。
    expect(result.processed).toBe(3)
    expect(result.nextCursorItemId).toBe('item-0002')
  })
})
