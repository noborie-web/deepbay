import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { countPending } from '@/lib/enrich-details'

// ユーザー要望(2026-10-17): 抽出を削除した商品も補完する。
// 抽出一覧から抽出を消すと products.extraction_id は null になる
// (ON DELETE SET NULL。商品はeBay出品中なので残す)。補完は抽出単位で動くため、
// それらが対象から漏れていた。実データでは509件が該当し、
// うち341件が写真1枚・仮の説明文のまま出品中だった。

function dbSpy() {
  const filters: Array<[string, string, unknown]> = []
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters.push(['eq', column, value]); return chain },
    is: (column: string, value: unknown) => { filters.push(['is', column, value]); return chain },
    in: () => chain,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ count: 7 }).then(resolve),
  }
  const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient
  return { db, filters }
}

describe('countPending の対象の絞り込み', () => {
  it('抽出IDを渡すとその抽出だけを数える', async () => {
    const { db, filters } = dbSpy()
    await countPending(db, 'user-1', 'extraction-1')
    expect(filters).toContainEqual(['eq', 'extraction_id', 'extraction-1'])
    expect(filters).not.toContainEqual(['is', 'extraction_id', null])
  })

  it('nullを渡すと「抽出が消えた商品」を数える', async () => {
    const { db, filters } = dbSpy()
    await countPending(db, 'user-1', null)
    expect(filters).toContainEqual(['is', 'extraction_id', null])
    // 他ユーザーの商品まで数えない
    expect(filters).toContainEqual(['eq', 'user_id', 'user-1'])
    expect(filters.some(([op, col]) => op === 'eq' && col === 'extraction_id')).toBe(false)
  })
})
