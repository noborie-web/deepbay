import { describe, expect, it } from 'vitest'
import { findBlockedProductDeletions } from '@/lib/product-deletion'

// 本番で判明した問題(2026-10-09): eBayに Kakehashi のラベルが付いた出品が
// 1,935件あり、うち626件は商品レコードが消えていて仕入先を追えなかった。
// 原因は、CSV出品だとeBayからItemIDが戻らず products.ebay_item_id が null の
// ままで、在庫管理にも載らないため、商品削除の安全装置が素通りしていたこと。
function makeDb(inventoryProductIds: string[]) {
  return {
    from() {
      const query = {
        select: () => query,
        eq: () => query,
        in: async () => ({ data: inventoryProductIds.map((id) => ({ product_id: id })), error: null }),
      }
      return query
    },
  }
}

const base = { ebay_title: 'Title', original_title: '元タイトル' }

describe('商品削除の安全装置', () => {
  it('出品CSVに出した商品は、ItemIDが無くても削除を止める', async () => {
    const blocked = await findBlockedProductDeletions(makeDb([]) as never, 'user-1', [
      { id: 'p1', ebay_item_id: null, listing_csv_exported_at: '2026-10-01T00:00:00.000Z', ...base },
    ])

    expect(blocked).toEqual([{ id: 'p1', title: 'Title' }])
  })

  it('出品していない商品は従来どおり削除できる', async () => {
    const blocked = await findBlockedProductDeletions(makeDb([]) as never, 'user-1', [
      { id: 'p1', ebay_item_id: null, listing_csv_exported_at: null, ...base },
    ])

    expect(blocked).toEqual([])
  })

  it('APIで出品した商品(ItemIDあり)は従来どおり止める', async () => {
    const blocked = await findBlockedProductDeletions(makeDb([]) as never, 'user-1', [
      { id: 'p1', ebay_item_id: '298731296337', listing_csv_exported_at: null, ...base },
    ])

    expect(blocked).toHaveLength(1)
  })

  it('在庫管理に載っている商品は従来どおり止める', async () => {
    const blocked = await findBlockedProductDeletions(makeDb(['p1']) as never, 'user-1', [
      { id: 'p1', ebay_item_id: null, listing_csv_exported_at: null, ...base },
    ])

    expect(blocked).toHaveLength(1)
  })

  it('印が無い商品だけを削除対象として残す', async () => {
    const blocked = await findBlockedProductDeletions(makeDb([]) as never, 'user-1', [
      { id: 'p1', ebay_item_id: null, listing_csv_exported_at: '2026-10-01T00:00:00.000Z', ...base },
      { id: 'p2', ebay_item_id: null, listing_csv_exported_at: null, ...base },
    ])

    expect(blocked.map((product) => product.id)).toEqual(['p1'])
  })
})
