import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncInventoryListings } from '@/lib/inventory-sync'

const { mockFetchAllActiveListings, mockUpsert } = vi.hoisted(() => ({
  mockFetchAllActiveListings: vi.fn(),
  mockUpsert: vi.fn(),
}))

vi.mock('@/lib/ebay-inventory', () => ({
  fetchAllActiveListings: mockFetchAllActiveListings,
}))

describe('syncInventoryListings', () => {
  beforeEach(() => {
    mockFetchAllActiveListings.mockReset()
    mockUpsert.mockReset().mockResolvedValue({ error: null })
  })

  it('matches products and stores the refreshed eBay snapshot', async () => {
    const managementCode = 'ele_20260802_abc123de_f456_7890_abcd_ef1234567890'
    mockFetchAllActiveListings.mockResolvedValue([
      {
        ebayItemId: 'item-1', customLabel: managementCode, title: 'Matched item',
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
    expect(mockFetchAllActiveListings).toHaveBeenCalledWith({ accessToken: 'access-token' })
    expect(mockUpsert).toHaveBeenCalledWith([
      expect.objectContaining({ ebay_item_id: 'item-1', product_id: 'product-1', user_id: 'user-1' }),
      expect.objectContaining({ ebay_item_id: 'item-2', product_id: null, user_id: 'user-1' }),
    ], { onConflict: 'user_id,ebay_item_id' })
  })
})
