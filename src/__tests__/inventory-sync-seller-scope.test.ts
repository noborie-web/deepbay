import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { purgeUnmanagedListings, storeInventoryListings } from '@/lib/inventory-sync'

// ユーザー要望(2026-09-25): 出品アカウントを複数運用する。「混在しないよう
// 細心の注意が必要」なので、取り込んだ出品には必ずセラーとサイト・通貨を
// 記録し、掃除(紐付かない行の削除)も自分のセラーの範囲だけに限定する。
const PRODUCT_ID = 'abcdef01-0000-4000-8000-000000000000'
const LABEL = `kakehashi_${PRODUCT_ID.replace(/-/g, '_')}`

function makeDb(captured: { upserts: Record<string, unknown>[]; deleteFilters: Array<[string, unknown]> }) {
  const productsTable = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn(async (column: string, values: string[]) => ({
      data: column === 'id' ? values.filter(v => v === PRODUCT_ID).map(id => ({ id })) : [],
      error: null,
    })),
    update: () => {
      const chain = { eq: () => chain, in: async () => ({ error: null }), neq: async () => ({ error: null }) }
      return chain
    },
  }
  const listingsTable = {
    upsert: vi.fn(async (rows: Record<string, unknown>[]) => { captured.upserts.push(...rows); return { error: null } }),
    delete: () => {
      const chain = {
        eq: (column: string, value: unknown) => { captured.deleteFilters.push([column, value]); return chain },
        is: (column: string, value: unknown) => { captured.deleteFilters.push([column, value]); return chain },
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      }
      return chain
    },
  }
  return {
    from: (table: string) => (table === 'products' ? productsTable : listingsTable),
  } as unknown as SupabaseClient
}

describe('在庫同期のセラー・サイト分離', () => {
  it('取り込んだ出品にセラーとサイト・通貨を記録する', async () => {
    const captured = { upserts: [] as Record<string, unknown>[], deleteFilters: [] as Array<[string, unknown]> }
    const db = makeDb(captured)

    await storeInventoryListings(db, 'user-1', [{
      ebayItemId: 'item-uk', customLabel: LABEL, title: 'UK item',
      currentPrice: 120.55, quantity: 1, quantitySold: 0, listingStatus: 'Active',
      startTime: null, endTime: null, siteId: 'UK', currency: 'GBP',
    }], { sellerAccountId: 'seller-b' })

    expect(captured.upserts).toHaveLength(1)
    expect(captured.upserts[0]).toMatchObject({
      ebay_item_id: 'item-uk',
      seller_account_id: 'seller-b',
      site_id: 'UK',
      currency: 'GBP',
    })
  })

  it('サイト・通貨が取得できなかった回は既定のUS/USDで上書きしない', async () => {
    const captured = { upserts: [] as Record<string, unknown>[], deleteFilters: [] as Array<[string, unknown]> }
    const db = makeDb(captured)

    await storeInventoryListings(db, 'user-1', [{
      ebayItemId: 'item-unknown', customLabel: LABEL, title: 'No site info',
      currentPrice: 10, quantity: 1, quantitySold: 0, listingStatus: 'Active',
      startTime: null, endTime: null, siteId: null, currency: null,
    }], { sellerAccountId: 'seller-b' })

    expect(captured.upserts[0]).not.toHaveProperty('site_id')
    expect(captured.upserts[0]).not.toHaveProperty('currency')
  })

  it('紐付かない出品の掃除は自分のセラーの範囲だけに限定する', async () => {
    const captured = { upserts: [] as Record<string, unknown>[], deleteFilters: [] as Array<[string, unknown]> }
    const db = makeDb(captured)

    await purgeUnmanagedListings(db, 'user-1', 'seller-b')

    expect(captured.deleteFilters).toEqual([
      ['user_id', 'user-1'],
      ['product_id', null],
      ['seller_account_id', 'seller-b'],
    ])
  })
})
