import { describe, it, expect, vi } from 'vitest'

const calls = vi.hoisted(() => ({ list: [] as Array<[string, ...unknown[]]> }))

vi.mock('@/lib/ebay-inventory', () => ({
  EbayCallLimitError: class extends Error {},
  fetchActiveListingsBatch: vi.fn(async () => ({ items: [], nextPage: null, totalPages: 1, lastFetchedPage: 1, truncated: false, ebayTotalPages: 1 })),
  fetchAllActiveListings: vi.fn(async () => ({ items: [], complete: true })),
  fetchListingsByItemIds: vi.fn(async () => ({ items: [], endedItemIds: [], endedListings: [] })),
  scanSellerListByStartTime: vi.fn(async () => ({ items: [], truncated: false, pagesFetched: 1, totalPages: 1 })),
  SELLER_LIST_MAX_RANGE_MS: 1000,
}))

import { syncKnownInventoryListings } from '@/lib/inventory-sync'

function db() {
  return {
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'is', 'like', 'lt', 'in', 'order', 'update', 'delete', 'upsert']) {
        chain[m] = vi.fn((...args: unknown[]) => {
          if (table === 'inventory_active_listings') calls.list.push([m, ...args])
          return chain
        })
      }
      chain.range = vi.fn(async () => ({ data: [], error: null }))
      chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }))
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      return chain
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('商品データが失われた出品も同期の対象にする', () => {
  // 本番で確認した不具合(2026-10-23): purgeUnmanagedListings は kakehashi_ ラベルの
  // 行を「画面で気づけるように」残すのに、collectKnownItemIds が集めていなかった。
  // そのため一度も再照会されず、eBay側で終了させても表示が消えなかった。
  it('product_id が null でも kakehashi_ ラベルの出品を照会対象に含める', async () => {
    calls.list.length = 0
    await syncKnownInventoryListings(db(), 'u1', 'token', {})
    expect(calls.list).toContainEqual(['like', 'custom_label', 'kakehashi\\_%'])
    expect(calls.list).toContainEqual(['like', 'custom_label', 'deepbay\\_%'])
    // 取り下げ済みは対象外(すでに決着している)
    expect(calls.list).toContainEqual(['is', 'delisted_at', null])
  })
})
