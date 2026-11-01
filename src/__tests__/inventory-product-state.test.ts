import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyListingStateToProducts } from '@/lib/inventory-sync'

// 本番で確認した不具合(2026-11-01): 商品1件ずつUPDATEを発行し、値が変わって
// いなくても毎回・全件に書いていた。miyabi-24 の同期1回で products への
// PATCHが2,192回(合計577秒・並行5で実時間約110秒)に達し、全体予算200秒を
// 超えて2人目(akebono-32)が「残り0秒」で飛ばされていた。
// あわせて listed_at に無条件で now を書いていたため、商品の出品日時が
// 「最後に同期した時刻」で潰されていた(4,493件中4,362件・平均18日のずれ)。

interface ProductRow { id: string; listing_status: string | null; ebay_item_id: string | null; listed_at: string | null }
interface Update { row: Record<string, unknown>; ids: string[] }

// products への読み書きだけを記録する最小限のモック。
// まとめて書く更新は .in('id', [...])、個別の更新は .eq('id', x) で終わる。
function makeDb(products: ProductRow[]) {
  const updates: Update[] = []
  const db = {
    from: (table: string) => {
      if (table !== 'products') throw new Error(`Unexpected table: ${table}`)
      const chain: Record<string, unknown> = {}
      let pending: Record<string, unknown> | null = null
      let singleId: string | null = null
      chain.select = () => chain
      chain.update = (row: Record<string, unknown>) => { pending = row; return chain }
      chain.eq = (column: string, value: string) => { if (column === 'id') singleId = value; return chain }
      chain.in = (_column: string, values: string[]) => {
        if (pending) { updates.push({ row: pending, ids: [...values] }); return Promise.resolve({ error: null }) }
        return Promise.resolve({ data: products.filter(p => values.includes(p.id)), error: null })
      }
      chain.then = (resolve: (v: unknown) => void) => {
        if (pending && singleId) updates.push({ row: pending, ids: [singleId] })
        return resolve({ error: null })
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { db, updates }
}

describe('商品の出品状態の反映', () => {
  it('値が変わっていない商品には一切書き込まない', async () => {
    const { db, updates } = makeDb([
      { id: 'p1', listing_status: 'listed', ebay_item_id: 'item-1', listed_at: '2026-09-13T11:55:59Z' },
      { id: 'p2', listing_status: 'listed', ebay_item_id: 'item-2', listed_at: '2026-09-14T11:55:59Z' },
    ])

    await applyListingStateToProducts(db, 'user-1', [
      { product_id: 'p1', ebay_item_id: 'item-1', quantity: 1, quantity_sold: 0 },
      { product_id: 'p2', ebay_item_id: 'item-2', quantity: 3, quantity_sold: 0 },
    ])

    // ここが本題。修正前は毎回2件とも書いていた
    expect(updates).toEqual([])
  })

  it('状態だけが変わる商品は、同じ値ごとにまとめて1回で更新する', async () => {
    const { db, updates } = makeDb([
      { id: 'p1', listing_status: 'listed', ebay_item_id: 'item-1', listed_at: '2026-09-13T11:55:59Z' },
      { id: 'p2', listing_status: 'listed', ebay_item_id: 'item-2', listed_at: '2026-09-14T11:55:59Z' },
      { id: 'p3', listing_status: 'listed', ebay_item_id: 'item-3', listed_at: '2026-09-15T11:55:59Z' },
    ])

    await applyListingStateToProducts(db, 'user-1', [
      // 残数0・販売あり → 売却済み
      { product_id: 'p1', ebay_item_id: 'item-1', quantity: 0, quantity_sold: 1 },
      { product_id: 'p2', ebay_item_id: 'item-2', quantity: 0, quantity_sold: 2 },
      // 残数0・販売なし → 取下げ
      { product_id: 'p3', ebay_item_id: 'item-3', quantity: 0, quantity_sold: 0 },
    ])

    expect(updates).toHaveLength(2)
    const sold = updates.find(u => u.row.listing_status === 'sold')
    expect(sold?.ids).toEqual(['p1', 'p2'])
    const delisted = updates.find(u => u.row.listing_status === 'delisted')
    expect(delisted?.ids).toEqual(['p3'])
    // まとめて書く更新で listed_at を触らない(出品日時を潰さない)
    expect(sold?.row).not.toHaveProperty('listed_at')
  })

  it('listed_at は未設定のときだけ、eBayの出品開始時刻を入れる', async () => {
    const { db, updates } = makeDb([
      { id: 'p1', listing_status: 'listed', ebay_item_id: 'item-1', listed_at: null },
      { id: 'p2', listing_status: 'listed', ebay_item_id: 'item-2', listed_at: '2026-09-14T11:55:59Z' },
    ])

    await applyListingStateToProducts(db, 'user-1', [
      { product_id: 'p1', ebay_item_id: 'item-1', quantity: 1, quantity_sold: 0, start_time: '2026-09-13T11:55:59Z' },
      // すでに入っている商品は、出品開始時刻を渡しても書き換えない
      { product_id: 'p2', ebay_item_id: 'item-2', quantity: 1, quantity_sold: 0, start_time: '2026-09-15T11:55:59Z' },
    ])

    expect(updates).toHaveLength(1)
    expect(updates[0].ids).toEqual(['p1'])
    expect(updates[0].row.listed_at).toBe('2026-09-13T11:55:59Z')
  })

  it('eBayのItemIDが変わった商品は個別に更新する', async () => {
    const { db, updates } = makeDb([
      { id: 'p1', listing_status: 'listed', ebay_item_id: 'old-item', listed_at: '2026-09-13T11:55:59Z' },
    ])

    await applyListingStateToProducts(db, 'user-1', [
      { product_id: 'p1', ebay_item_id: 'new-item', quantity: 1, quantity_sold: 0 },
    ])

    expect(updates).toHaveLength(1)
    expect(updates[0].ids).toEqual(['p1'])
    expect(updates[0].row.ebay_item_id).toBe('new-item')
    expect(updates[0].row).not.toHaveProperty('listed_at')
  })

  it('読めなかった商品(他ユーザー・削除済み)には書き込まない', async () => {
    const { db, updates } = makeDb([])

    await applyListingStateToProducts(db, 'user-1', [
      { product_id: 'gone', ebay_item_id: 'item-1', quantity: 0, quantity_sold: 0 },
    ])

    expect(updates).toEqual([])
  })
})
