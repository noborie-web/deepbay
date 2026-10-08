import { describe, expect, it } from 'vitest'
import { storeInventoryListings } from '@/lib/inventory-sync'

// ユーザー報告(2026-10-08): 売れた商品のDBK-IDで復元できない件を調べたところ、
// 同期のたびに miyabi-24 の350件(895件中)が「商品レコードが無い」ために黙って
// 捨てられていた。捨てると在庫管理にも載らず、仕入先チェックも取り下げも
// 行われないため、仕入先が売り切れても出品が残り続ける。
function makeDatabase() {
  const upserted: Array<Record<string, unknown>> = []
  const db = {
    from(table: string) {
      const state = { update: false }
      const query = {
        select() { return query },
        eq() { return query },
        in() { return query },
        is() { return query },
        not() { return query },
        update() { state.update = true; return query },
        delete() { state.update = true; return query },
        upsert(rows: Array<Record<string, unknown>>) {
          if (table === 'inventory_active_listings') upserted.push(...rows)
          return Promise.resolve({ data: null, error: null })
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(resolve)
        },
      }
      return query
    },
  }
  return { db, upserted }
}

const listing = (customLabel: string | null, ebayItemId: string) => ({
  ebayItemId,
  customLabel,
  title: 'Item',
  imageUrl: null,
  currentPrice: 10,
  quantity: 1,
  quantitySold: 0,
  listingStatus: 'Active',
  startTime: null,
  endTime: null,
  siteId: 'US',
  currency: 'USD',
})

describe('商品レコードが失われたKakehashi出品', () => {
  it('捨てずに保存し、件数を unmanaged として返す', async () => {
    const { db, upserted } = makeDatabase()

    const result = await storeInventoryListings(db as never, 'user-1', [
      listing('kakehashi_ee63e9c7_90ca_4ea8_a978_b96f6c410220', '298731296337'),
    ], {})

    expect(result.total).toBe(1)
    expect(result.matched).toBe(0)
    expect(result.unmanaged).toBe(1)
    expect(upserted).toHaveLength(1)
    expect(upserted[0].product_id).toBeNull()
    expect(upserted[0].ebay_item_id).toBe('298731296337')
  })

  it('旧接頭辞(deepbay_)の出品も保存する', async () => {
    const { db, upserted } = makeDatabase()

    const result = await storeInventoryListings(db as never, 'user-1', [
      listing('deepbay_ee63e9c7_90ca_4ea8_a978_b96f6c410220', '1'),
    ], {})

    expect(result.unmanaged).toBe(1)
    expect(upserted).toHaveLength(1)
  })

  it('Kakehashiの印が無い他ツールの出品は、従来どおり保存しない', async () => {
    const { db, upserted } = makeDatabase()

    const result = await storeInventoryListings(db as never, 'user-1', [
      listing('other-tool-sku-123', '2'),
      listing(null, '3'),
    ], {})

    expect(result.total).toBe(2)
    expect(result.unmanaged).toBe(0)
    expect(upserted).toHaveLength(0)
  })
})
