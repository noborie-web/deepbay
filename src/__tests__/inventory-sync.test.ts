import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncInventoryListingBatch, syncInventoryListings } from '@/lib/inventory-sync'

const { mockFetchActiveListingsBatch, mockFetchAllActiveListings, mockUpsert, mockDeleteIs } = vi.hoisted(() => ({
  mockFetchActiveListingsBatch: vi.fn(),
  mockFetchAllActiveListings: vi.fn(),
  mockUpsert: vi.fn(),
  mockDeleteIs: vi.fn(),
}))

// inventory_active_listings のモック。同期の最後に「紐付かない出品の掃除」
// (delete().eq().is('product_id', null)) が走るため、そのチェーンも用意する。
function listingTable() {
  return {
    upsert: mockUpsert,
    delete: () => ({ eq: () => ({ is: mockDeleteIs }) }),
  }
}

// Kakehashiの出品ラベル(kakehashi_{商品UUID})とそのUUIDを index から生成する。
function kakehashiLabel(index: number): { label: string; productId: string } {
  const hex = index.toString(16).padStart(8, '0')
  return {
    label: `kakehashi_${hex}_0000_4000_8000_000000000000`,
    productId: `${hex}-0000-4000-8000-000000000000`,
  }
}

// products テーブルのモック: id で問い合わせられた分だけ存在するものとして返す。
// products.update(...) の呼び出し(listing_status / ebay_item_id の更新)を記録する
const mockProductUpdate = vi.fn()
const productUpdateMock = {
  update: (payload: Record<string, unknown>) => {
    const chain = {
      eq: (column: string, value: string) => {
        if (column === 'id') mockProductUpdate({ id: value, ...payload })
        return chain
      },
      in: async () => ({ error: null }),
      neq: async () => ({ error: null }),
    }
    return chain
  },
}

function productsTableFor(productIds: string[]) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn(async (column: string, values: string[]) => ({
      data: column === 'id' ? values.filter(id => productIds.includes(id)).map(id => ({ id })) : [],
      error: null,
    })),
    ...productUpdateMock,
  }
}

vi.mock('@/lib/ebay-inventory', () => ({
  fetchActiveListingsBatch: mockFetchActiveListingsBatch,
  fetchAllActiveListings: mockFetchAllActiveListings,
}))

describe('syncInventoryListings', () => {
  beforeEach(() => {
    mockFetchActiveListingsBatch.mockReset()
    mockFetchAllActiveListings.mockReset()
    mockUpsert.mockReset().mockResolvedValue({ error: null })
    mockDeleteIs.mockReset().mockResolvedValue({ error: null })
    mockProductUpdate.mockReset()
  })

  it('matches products and stores the refreshed eBay snapshot', async () => {
    const managementCode = 'ele_20260802_abc123de_f456_7890_abcd_ef1234567890'
    mockFetchAllActiveListings.mockResolvedValue([
      {
        ebayItemId: 'item-1', customLabel: managementCode, title: 'Matched item',
        imageUrl: 'https://i.ebayimg.com/images/g/item-1/s-l140.jpg',
        currentPrice: 20, quantity: 1, quantitySold: 0, listingStatus: 'Active',
        startTime: '2026-07-01T00:00:00.000Z', endTime: null,
      },
      {
        ebayItemId: 'item-2', customLabel: 'other-sku', title: 'Unmatched item',
        currentPrice: 10, quantity: 2, quantitySold: 0, listingStatus: 'Active',
        startTime: '2026-07-02T00:00:00.000Z', endTime: null,
      },
    ])

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') {
          return {
            ...productUpdateMock,
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn(async () => ({
              data: [{ id: 'product-1', source_item_id: managementCode }],
              error: null,
            })),
          }
        }
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(db, 'user-1', 'access-token')

    expect(result).toEqual({ total: 2, matched: 1 })
    expect(mockFetchAllActiveListings).toHaveBeenCalledWith(
      { accessToken: 'access-token' },
      { signal: undefined },
    )
    // ユーザー要望: 他ツールで在庫管理中の出品(Kakehashi商品に紐付かない
    // もの)は混在させない。紐付いた item-1 だけ保存し、item-2 は保存しない。
    expect(mockUpsert).toHaveBeenCalledWith([
      expect.objectContaining({
        ebay_item_id: 'item-1', product_id: 'product-1', user_id: 'user-1',
        raw_data: { image_url: 'https://i.ebayimg.com/images/g/item-1/s-l140.jpg' },
      }),
    ], { onConflict: 'user_id,ebay_item_id' })
    expect(mockUpsert.mock.calls.flat(2)).not.toContainEqual(expect.objectContaining({ ebay_item_id: 'item-2' }))
    // 以前の仕様で取り込まれた紐付かない行も掃除する
    expect(mockDeleteIs).toHaveBeenCalledWith('product_id', null)
    // 実データで確認した不具合: 紐付いた商品の listing_status が draft の
    // ままで「出品中」の集計が0のままだった。紐付いた商品を出品中にする。
    expect(mockProductUpdate).toHaveBeenCalledWith(expect.objectContaining({
      id: 'product-1', ebay_item_id: 'item-1', listing_status: 'listed',
    }))
  })

  it('matches current Kakehashi labels by product UUID', async () => {
    const productId = '01234567-89ab-cdef-0123-456789abcdef'
    mockFetchAllActiveListings.mockResolvedValue([{
      ebayItemId: 'item-current', customLabel: 'kakehashi_01234567_89ab_cdef_0123_456789abcdef', title: 'Current label',
      currentPrice: 20, quantity: 1, quantitySold: 0, listingStatus: 'Active', startTime: null, endTime: null,
    }])
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return {
          ...productUpdateMock,
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          in: vi.fn(async (column: string) => ({ data: column === 'id' ? [{ id: productId }] : [], error: null })),
        }
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient
    await expect(syncInventoryListings(db, 'user-1', 'access-token')).resolves.toEqual({ total: 1, matched: 1 })
    expect(mockUpsert).toHaveBeenCalledWith([expect.objectContaining({ product_id: productId })], { onConflict: 'user_id,ebay_item_id' })
  })

  // ツール名変更前に出品された商品は、CustomLabelが旧接頭辞"deepbay_"のまま
  // なので、既存の実出品との紐付けが壊れないよう引き続き認識できる必要がある。
  it('matches legacy DeepBay labels by product UUID', async () => {
    const productId = '01234567-89ab-cdef-0123-456789abcdef'
    mockFetchAllActiveListings.mockResolvedValue([{
      ebayItemId: 'item-legacy', customLabel: 'deepbay_01234567_89ab_cdef_0123_456789abcdef', title: 'Legacy label',
      currentPrice: 20, quantity: 1, quantitySold: 0, listingStatus: 'Active', startTime: null, endTime: null,
    }])
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return {
          ...productUpdateMock,
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          in: vi.fn(async (column: string) => ({ data: column === 'id' ? [{ id: productId }] : [], error: null })),
        }
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient
    await expect(syncInventoryListings(db, 'user-1', 'access-token')).resolves.toEqual({ total: 1, matched: 1 })
    expect(mockUpsert).toHaveBeenCalledWith([expect.objectContaining({ product_id: productId })], { onConflict: 'user_id,ebay_item_id' })
  })

  it('matches DeepBay labels stored as source_item_id', async () => {
    const customLabel = 'deepbay_01234567_89ab_cdef_0123_456789abcdef'
    mockFetchAllActiveListings.mockResolvedValue([{
      ebayItemId: 'item-source', customLabel, title: 'Source label',
      currentPrice: 20, quantity: 1, quantitySold: 0, listingStatus: 'Active', startTime: null, endTime: null,
    }])
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return {
          ...productUpdateMock,
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          in: vi.fn(async (column: string) => ({
            data: column === 'source_item_id'
              ? [{ id: 'source-product', source_item_id: customLabel }]
              : [],
            error: null,
          })),
        }
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    await expect(syncInventoryListings(db, 'user-1', 'access-token')).resolves.toEqual({ total: 1, matched: 1 })
    expect(mockUpsert).toHaveBeenCalledWith(
      [expect.objectContaining({ product_id: 'source-product' })],
      { onConflict: 'user_id,ebay_item_id' },
    )
  })

  it('does not auto-match an ambiguous source_item_id', async () => {
    const customLabel = 'deepbay_not-a-product-uuid'
    mockFetchAllActiveListings.mockResolvedValue([{
      ebayItemId: 'item-ambiguous', customLabel, title: 'Ambiguous label',
      currentPrice: 20, quantity: 1, quantitySold: 0, listingStatus: 'Active', startTime: null, endTime: null,
    }])
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return {
          ...productUpdateMock,
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          in: vi.fn(async (column: string) => ({
            data: column === 'source_item_id'
              ? [
                  { id: 'product-1', source_item_id: customLabel },
                  { id: 'product-2', source_item_id: customLabel },
                ]
              : [],
            error: null,
          })),
        }
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    await expect(syncInventoryListings(db, 'user-1', 'access-token')).resolves.toEqual({ total: 1, matched: 0 })
    // 紐付け先を一意に決められない出品はKakehashi管理外として保存しない
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('stores listing chunks concurrently', async () => {
    const concurrencyIds = Array.from({ length: 450 }, (_, index) => kakehashiLabel(index).productId)
    mockFetchAllActiveListings.mockResolvedValue(Array.from({ length: 450 }, (_, index) => ({
      ebayItemId: `item-${index}`,
      customLabel: kakehashiLabel(index).label,
      title: `Item ${index}`,
      currentPrice: 10,
      quantity: 1,
      quantitySold: 0,
      listingStatus: 'Active',
      startTime: null,
      endTime: null,
    })))

    let activeWrites = 0
    let maxActiveWrites = 0
    mockUpsert.mockImplementation(async () => {
      activeWrites += 1
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      await new Promise(resolve => setTimeout(resolve, 5))
      activeWrites -= 1
      return { error: null }
    })

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return productsTableFor(concurrencyIds)
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(
      db,
      'user-1',
      'access-token',
      { writeConcurrency: 4 },
    )

    expect(result).toEqual({ total: 450, matched: 450 })
    expect(mockUpsert).toHaveBeenCalledTimes(5)
    expect(maxActiveWrites).toBe(4)
  })

  it('chunks large product lookups to keep Supabase filter requests bounded', async () => {
    const listings = Array.from({ length: 205 }, (_, index) => {
      const hex = index.toString(16).padStart(8, '0')
      return {
        ebayItemId: `item-${index}`,
        customLabel: `ele_20260802_${hex}_f456_7890_abcd_ef1234567890`,
        title: `Item ${index}`,
        currentPrice: 10,
        quantity: 1,
        quantitySold: 0,
        listingStatus: 'Active',
        startTime: null,
        endTime: null,
      }
    })
    mockFetchAllActiveListings.mockResolvedValue(listings)

    const productLookupCalls: string[][] = []
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn(async (_column: string, values: string[]) => {
              productLookupCalls.push(values)
              return { data: [], error: null }
            }),
          }
        }
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(db, 'user-1', 'access-token')

    expect(result).toEqual({ total: 205, matched: 0 })
    expect(productLookupCalls.map(values => values.length)).toEqual([205, 100, 100, 5])
    // 紐付かない出品は保存しないため書き込みは発生しない
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('deduplicates overlapping eBay item ids before one upsert', async () => {
    mockFetchAllActiveListings.mockResolvedValue([
      {
        ebayItemId: 'item-1', customLabel: kakehashiLabel(1).label, title: 'Older page result',
        currentPrice: 10, quantity: 1, quantitySold: 0, listingStatus: 'Active',
        startTime: null, endTime: null,
      },
      {
        ebayItemId: 'item-1', customLabel: kakehashiLabel(1).label, title: 'Latest page result',
        currentPrice: 12, quantity: 1, quantitySold: 0, listingStatus: 'Active',
        startTime: null, endTime: null,
      },
    ])

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return productsTableFor([kakehashiLabel(1).productId])
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(db, 'user-1', 'access-token')

    expect(result).toEqual({ total: 1, matched: 1 })
    expect(mockUpsert).toHaveBeenCalledWith([
      expect.objectContaining({
        ebay_item_id: 'item-1',
        title: 'Latest page result',
        current_price: 12,
      }),
    ], { onConflict: 'user_id,ebay_item_id' })
  })

  it('stores one resumable eBay page batch and returns its progress', async () => {
    mockFetchActiveListingsBatch.mockResolvedValue({
      items: [{
        ebayItemId: 'item-5', customLabel: kakehashiLabel(5).label, title: 'Page 5 item',
        currentPrice: 10, quantity: 1, quantitySold: 0, listingStatus: 'Active',
        startTime: null, endTime: null,
      }],
      nextPage: 9,
      totalPages: 12,
      lastFetchedPage: 8,
    })

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return productsTableFor([kakehashiLabel(5).productId])
        if (table === 'inventory_active_listings') return listingTable()
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListingBatch(
      db,
      'user-1',
      'access-token',
      5,
      4,
    )

    expect(mockFetchActiveListingsBatch).toHaveBeenCalledWith(
      { accessToken: 'access-token' },
      5,
      4,
      { signal: undefined },
    )
    expect(result).toEqual({
      total: 1,
      matched: 1,
      nextPage: 9,
      totalPages: 12,
      lastFetchedPage: 8,
    })
  })
})
