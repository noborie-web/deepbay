import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncInventoryListingBatch, syncInventoryListings } from '@/lib/inventory-sync'

const { mockFetchActiveListingsBatch, mockFetchAllActiveListings, mockUpsert } = vi.hoisted(() => ({
  mockFetchActiveListingsBatch: vi.fn(),
  mockFetchAllActiveListings: vi.fn(),
  mockUpsert: vi.fn(),
}))

vi.mock('@/lib/ebay-inventory', () => ({
  fetchActiveListingsBatch: mockFetchActiveListingsBatch,
  fetchAllActiveListings: mockFetchAllActiveListings,
}))

describe('syncInventoryListings', () => {
  beforeEach(() => {
    mockFetchActiveListingsBatch.mockReset()
    mockFetchAllActiveListings.mockReset()
    mockUpsert.mockReset().mockResolvedValue({ error: null })
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
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn(async () => ({
              data: [{ id: 'product-1', source_item_id: managementCode }],
              error: null,
            })),
          }
        }
        if (table === 'inventory_active_listings') return { upsert: mockUpsert }
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(db, 'user-1', 'access-token')

    expect(result).toEqual({ total: 2, matched: 1 })
    expect(mockFetchAllActiveListings).toHaveBeenCalledWith(
      { accessToken: 'access-token' },
      { signal: undefined },
    )
    expect(mockUpsert).toHaveBeenCalledWith([
      expect.objectContaining({
        ebay_item_id: 'item-1', product_id: 'product-1', user_id: 'user-1',
        raw_data: { image_url: 'https://i.ebayimg.com/images/g/item-1/s-l140.jpg' },
      }),
      expect.objectContaining({ ebay_item_id: 'item-2', product_id: null, user_id: 'user-1' }),
    ], { onConflict: 'user_id,ebay_item_id' })
  })

  it('matches current DeepBay labels by product UUID', async () => {
    const productId = '01234567-89ab-cdef-0123-456789abcdef'
    mockFetchAllActiveListings.mockResolvedValue([{
      ebayItemId: 'item-current', customLabel: 'deepbay_01234567_89ab_cdef_0123_456789abcdef', title: 'Current label',
      currentPrice: 20, quantity: 1, quantitySold: 0, listingStatus: 'Active', startTime: null, endTime: null,
    }])
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          in: vi.fn(async (column: string) => ({ data: column === 'id' ? [{ id: productId }] : [], error: null })),
        }
        if (table === 'inventory_active_listings') return { upsert: mockUpsert }
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient
    await expect(syncInventoryListings(db, 'user-1', 'access-token')).resolves.toEqual({ total: 1, matched: 1 })
    expect(mockUpsert).toHaveBeenCalledWith([expect.objectContaining({ product_id: productId })], { onConflict: 'user_id,ebay_item_id' })
  })

  it('stores listing chunks concurrently', async () => {
    mockFetchAllActiveListings.mockResolvedValue(Array.from({ length: 450 }, (_, index) => ({
      ebayItemId: `item-${index}`,
      customLabel: null,
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
        if (table === 'inventory_active_listings') return { upsert: mockUpsert }
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(
      db,
      'user-1',
      'access-token',
      { writeConcurrency: 4 },
    )

    expect(result).toEqual({ total: 450, matched: 0 })
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
        if (table === 'inventory_active_listings') return { upsert: mockUpsert }
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(db, 'user-1', 'access-token')

    expect(result).toEqual({ total: 205, matched: 0 })
    expect(productLookupCalls.map(values => values.length)).toEqual([100, 100, 5])
    expect(mockUpsert).toHaveBeenCalledTimes(3)
  })

  it('deduplicates overlapping eBay item ids before one upsert', async () => {
    mockFetchAllActiveListings.mockResolvedValue([
      {
        ebayItemId: 'item-1', customLabel: null, title: 'Older page result',
        currentPrice: 10, quantity: 1, quantitySold: 0, listingStatus: 'Active',
        startTime: null, endTime: null,
      },
      {
        ebayItemId: 'item-1', customLabel: null, title: 'Latest page result',
        currentPrice: 12, quantity: 1, quantitySold: 0, listingStatus: 'Active',
        startTime: null, endTime: null,
      },
    ])

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'inventory_active_listings') return { upsert: mockUpsert }
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    const result = await syncInventoryListings(db, 'user-1', 'access-token')

    expect(result).toEqual({ total: 1, matched: 0 })
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
        ebayItemId: 'item-5', customLabel: null, title: 'Page 5 item',
        currentPrice: 10, quantity: 1, quantitySold: 0, listingStatus: 'Active',
        startTime: null, endTime: null,
      }],
      nextPage: 9,
      totalPages: 12,
      lastFetchedPage: 8,
    })

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'inventory_active_listings') return { upsert: mockUpsert }
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
      matched: 0,
      nextPage: 9,
      totalPages: 12,
      lastFetchedPage: 8,
    })
  })
})
