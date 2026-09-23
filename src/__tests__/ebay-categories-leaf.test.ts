import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// 本番で確認した不具合(2026-09-23): 親カテゴリ 222(Diecast & Toy Vehicles)で
// 出力したCSVが、eBayで「The category selected is not a leaf category.」により
// 全件エラーになった。検索結果に leaf 判定を付け、親カテゴリは登録させない。
const rows = [
  { id: '222', name: 'Diecast & Toy Vehicles', level: 2 },
  { id: '180273', name: 'Cars, Trucks & Vans', level: 3 },
  { id: '180506', name: 'Contemporary Manufacture', level: 4 },
]
const childrenOf: Record<string, Array<{ id: string; name: string; level: number }>> = {
  '222': [{ id: '180273', name: 'Cars, Trucks & Vans', level: 3 }],
  '180273': [{ id: '180506', name: 'Contemporary Manufacture', level: 4 }],
  '180506': [],
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => {
      const state: { ids: string[]; parent: string | null; search: string | null } = { ids: [], parent: null, search: null }
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.in = (_col: string, ids: string[]) => { state.ids = ids; return chain }
      chain.eq = (_col: string, v: string) => { state.parent = v; return chain }
      chain.ilike = (_col: string, v: string) => { state.search = v; return chain }
      chain.or = (v: string) => { state.search = v; return chain }
      chain.order = () => chain
      chain.limit = () => chain
      chain.then = (resolve: (v: unknown) => void) => {
        if (state.ids.length > 0) {
          // 子の有無を返す(leaf判定用)
          const data = state.ids.flatMap(id => (childrenOf[id] ?? []).map(() => ({ parent_id: id })))
          return resolve({ data, error: null })
        }
        if (state.parent) return resolve({ data: childrenOf[state.parent] ?? [], error: null })
        return resolve({ data: rows, error: null })
      }
      return chain
    },
  })),
}))

describe('GET /api/ebay-categories', () => {
  it('検索結果に leaf 判定を付ける(親カテゴリは is_leaf=false)', async () => {
    const { GET } = await import('@/app/api/ebay-categories/route')
    const res = await GET(new NextRequest('http://localhost/api/ebay-categories?q=diecast'))
    const json = await res.json()
    expect(json).toEqual([
      { id: '222', name: 'Diecast & Toy Vehicles', level: 2, is_leaf: false },
      { id: '180273', name: 'Cars, Trucks & Vans', level: 3, is_leaf: false },
      { id: '180506', name: 'Contemporary Manufacture', level: 4, is_leaf: true },
    ])
  })

  it('mode=children で子カテゴリ(leaf判定付き)を返す', async () => {
    const { GET } = await import('@/app/api/ebay-categories/route')
    const res = await GET(new NextRequest('http://localhost/api/ebay-categories?mode=children&parent=180273'))
    expect(await res.json()).toEqual([
      { id: '180506', name: 'Contemporary Manufacture', level: 4, is_leaf: true },
    ])
  })
})
