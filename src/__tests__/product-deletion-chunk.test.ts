import { describe, it, expect, vi } from 'vitest'
import { findBlockedProductDeletions } from '@/lib/product-deletion'
import { ID_CHUNK_SIZE } from '@/lib/db-chunk'

function makeProducts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    ebay_item_id: null,
    ebay_title: `title ${i}`,
    original_title: `orig ${i}`,
    listing_csv_exported_at: null,
  }))
}

/** .in('product_id', chunk) の chunk を記録しつつ、listedIds だけを返す */
function makeDb(listedIds: Set<string>, chunks: string[][], error?: { message: string }) {
  return {
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn(() => chain)
      chain.eq = vi.fn(() => chain)
      chain.in = vi.fn(async (_col: string, ids: string[]) => {
        chunks.push(ids)
        if (error) return { data: null, error }
        return { data: ids.filter(id => listedIds.has(id)).map(id => ({ product_id: id })), error: null }
      })
      return chain
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('抽出削除の安全装置', () => {
  // 本番で確認した不具合(2026-10-22): .in('product_id', 全商品ID) は100件を
  // 超えるとURLが長すぎて400になり、100件超の抽出は削除しようとすると必ず
  // エラーになっていた(ファミコン590件・スーパーファミコン286件が該当)。
  it('590件でも100件ずつに分割して引く', async () => {
    const chunks: string[][] = []
    await findBlockedProductDeletions(makeDb(new Set(), chunks), 'u1', makeProducts(590))
    expect(chunks.length).toBe(6)
    expect(Math.max(...chunks.map(c => c.length))).toBeLessThanOrEqual(ID_CHUNK_SIZE)
    expect(chunks.flat().length).toBe(590)
  })

  it('分割しても出品中の商品は最後まで守られる(後半のチャンクも見る)', async () => {
    const chunks: string[][] = []
    // 最後のチャンクにしか現れないIDを出品中にする
    const db = makeDb(new Set(['p589']), chunks)
    const blocked = await findBlockedProductDeletions(db, 'u1', makeProducts(590))
    expect(blocked.map(b => b.id)).toEqual(['p589'])
  })

  it('取得に失敗したら投げる(握りつぶすと出品中を削除してしまう)', async () => {
    const db = makeDb(new Set(), [], { message: 'URI too long' })
    await expect(findBlockedProductDeletions(db, 'u1', makeProducts(590))).rejects.toThrow('URI too long')
  })

  it('CSV出品済み(ItemIDが無い)も守る', async () => {
    const products = makeProducts(3)
    products[1].listing_csv_exported_at = '2026-10-02T00:00:00.000Z' as never
    const blocked = await findBlockedProductDeletions(makeDb(new Set(), []), 'u1', products)
    expect(blocked.map(b => b.id)).toEqual(['p1'])
  })
})
