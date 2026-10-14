import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isEndedListing } from '@/lib/inventory'
import { storeInventoryListings } from '@/lib/inventory-sync'

// 本番で確認した不具合(2026-10-13): ユーザーが10/10に取り下げた100件が、
// 10/13のCSV取込(未管理0件)の9分後の同期で「出品中」として在庫管理に
// よみがえった。新規出品の発見に使う GetSellerList は StartTimeFrom/To で
// 期間を絞るだけなので、その期間に出品されたものを終了済みも含めて返す。
// 終了済みを保存すると在庫一覧の件数が水増しされ、仕入先チェックも
// すでに終了した出品に対して走ってしまう。

describe('isEndedListing', () => {
  const now = Date.parse('2026-10-13T11:28:00.000Z')

  it('EndTimeが過去なら終了済みとみなす(ListingStatusが返らない実データ)', () => {
    expect(isEndedListing({ listingStatus: null, endTime: '2026-10-10T23:40:20.000Z' }, now)).toBe(true)
  })

  it('EndTimeが未来なら出品中のまま', () => {
    expect(isEndedListing({ listingStatus: null, endTime: '2026-12-01T00:00:00.000Z' }, now)).toBe(false)
  })

  it('EndTimeが無い出品(GTC等)は出品中のまま', () => {
    expect(isEndedListing({ listingStatus: 'Active', endTime: null }, now)).toBe(false)
  })

  it('ListingStatusがActive以外なら終了済みとみなす', () => {
    expect(isEndedListing({ listingStatus: 'Completed', endTime: null }, now)).toBe(true)
    expect(isEndedListing({ listingStatus: 'Ended', endTime: '2099-01-01T00:00:00.000Z' }, now)).toBe(true)
  })
})

describe('storeInventoryListings: 終了済みの出品', () => {
  const productId = '9ef13534-4516-4002-ae6e-defdf80b4d54'
  const label = 'kakehashi_9ef13534_4516_4002_ae6e_defdf80b4d54'

  function dbWithSpies() {
    const upsertListing = vi.fn().mockResolvedValue({ error: null })
    const upsertEnded = vi.fn().mockResolvedValue({ error: null })
    const deletedIds: string[][] = []

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'products') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn(async () => ({ data: [], error: null })),
            update: () => {
              const chain = {
                eq: () => chain,
                in: () => chain,
                neq: () => chain,
                then: (resolve: (value: unknown) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve),
              }
              return chain
            },
          }
        }
        if (table === 'inventory_ended_listings') return { upsert: upsertEnded }
        if (table === 'inventory_active_listings') {
          return {
            upsert: upsertListing,
            // 終了履歴の記録は、消す前に在庫一覧から現在の行を読む
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn((_column: string, ids: string[]) => {
                  const rows = ids.map(id => ({
                    ebay_item_id: id, custom_label: label, product_id: productId,
                    title: 'Ended item', site_id: 'US', currency: 'USD',
                    current_price: 174.5, quantity: 1, quantity_sold: 0,
                    seller_account_id: null,
                  }))
                  // 商品への反映(markProductsForEndedListings)は .not(...) を続ける
                  const chain = {
                    not: () => chain,
                    then: (resolve: (value: unknown) => unknown) =>
                      Promise.resolve({ data: rows, error: null }).then(resolve),
                  }
                  return chain
                }),
              }),
            }),
            delete: () => ({
              eq: () => ({
                in: async (_column: string, ids: string[]) => { deletedIds.push(ids); return { error: null } },
              }),
            }),
          }
        }
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as SupabaseClient

    return { db, upsertListing, upsertEnded, deletedIds }
  }

  it('EndTimeが過去の出品は「出品中」として保存せず、終了として扱う', async () => {
    const { db, upsertListing, upsertEnded, deletedIds } = dbWithSpies()

    const result = await storeInventoryListings(db, 'user-1', [{
      ebayItemId: '377535920770', customLabel: label, title: 'ZPI Carbon Handle',
      currentPrice: 174.5, quantity: 1, quantitySold: 0, listingStatus: null,
      startTime: '2026-10-01T00:00:00.000Z', endTime: '2026-10-10T23:40:20.000Z',
    }])

    expect(result).toEqual({ total: 0, matched: 0, unmanaged: 0, ended: 1 })
    // 出品中のスナップショットには書かない
    expect(upsertListing.mock.calls.flat(2)).not.toContainEqual(
      expect.objectContaining({ ebay_item_id: '377535920770' }),
    )
    // 終了履歴に残して、在庫一覧からは外す
    expect(upsertEnded).toHaveBeenCalledWith(
      [expect.objectContaining({ ebay_item_id: '377535920770', ended_at: '2026-10-10T23:40:20.000Z' })],
      { onConflict: 'user_id,ebay_item_id' },
    )
    expect(deletedIds).toEqual([['377535920770']])
  })

  it('EndTimeが未来の出品は従来どおり保存する', async () => {
    const { db, upsertListing, upsertEnded } = dbWithSpies()

    const result = await storeInventoryListings(db, 'user-1', [{
      ebayItemId: 'item-live', customLabel: label, title: 'Live item',
      currentPrice: 20, quantity: 1, quantitySold: 0, listingStatus: 'Active',
      startTime: '2026-10-01T00:00:00.000Z', endTime: '2099-01-01T00:00:00.000Z',
    }])

    expect(result).toMatchObject({ total: 1, ended: 0 })
    expect(upsertListing).toHaveBeenCalledWith(
      [expect.objectContaining({ ebay_item_id: 'item-live' })],
      { onConflict: 'user_id,ebay_item_id' },
    )
    expect(upsertEnded).not.toHaveBeenCalled()
  })
})
