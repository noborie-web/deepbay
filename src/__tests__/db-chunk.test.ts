import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { chunkIds, ID_CHUNK_SIZE, selectAllRows, selectByIds } from '@/lib/db-chunk'

// 本番で確認した不具合(2026-10-20): 価格改定が一度も実行されていなかった。
// 出品2,632件のうち2,091件が対象なのに、記録は毎回 total: 0。
// 原因は「1,000件超を .in(...) に渡してURLが長すぎて400」+「errorを見ていない」。
// 商品が引けないと目標価格が無いとみなされ、全件が黙って対象から外れていた。

function dbWithIn(handler: (ids: string[]) => { data?: unknown[]; error?: { message: string } }) {
  const calls: string[][] = []
  const db = {
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => { calls.push(ids); return handler(ids) },
      }),
    }),
  } as unknown as SupabaseClient
  return { db, calls }
}

describe('chunkIds', () => {
  it('URLが長くなりすぎない件数に分ける', () => {
    const chunks = chunkIds(Array.from({ length: 250 }, (_, i) => `id-${i}`))
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(ID_CHUNK_SIZE)
    expect(chunks.flat()).toHaveLength(250)
  })

  it('空なら何も返さない', () => {
    expect(chunkIds([])).toEqual([])
  })
})

describe('selectByIds', () => {
  it('1,000件超でも分割して全件引く', async () => {
    const ids = Array.from({ length: 1050 }, (_, i) => `id-${i}`)
    const { db, calls } = dbWithIn((chunk) => ({ data: chunk.map((id) => ({ id })) }))

    const rows = await selectByIds<{ id: string }>(db, 'products', 'id', ids)

    expect(rows).toHaveLength(1050)
    expect(calls).toHaveLength(11)
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(ID_CHUNK_SIZE)
  })

  // ここを握りつぶすと「対象0件」と区別がつかず、今回のように黙って止まる
  it('エラーは握りつぶさず投げる', async () => {
    const { db } = dbWithIn(() => ({ error: { message: 'URI too long' } }))
    await expect(selectByIds(db, 'products', 'id', ['a'])).rejects.toThrow('URI too long')
  })
})

describe('selectAllRows', () => {
  it('1,000行の上限を超えてもページ送りで全件取る', async () => {
    const total = 2632
    const range = vi.fn(async (from: number, to: number) => ({
      data: Array.from(
        { length: Math.max(0, Math.min(to, total - 1) - from + 1) },
        (_, i) => ({ id: `row-${from + i}` }),
      ),
    }))
    const rows = await selectAllRows<{ id: string }>(() => ({ range }), { pageSize: 500 })

    expect(rows).toHaveLength(total)
    expect(new Set(rows.map((r) => r.id)).size).toBe(total)
  })

  it('エラーは握りつぶさず投げる', async () => {
    const range = async () => ({ error: { message: 'boom' } })
    await expect(selectAllRows(() => ({ range }))).rejects.toThrow('boom')
  })
})
