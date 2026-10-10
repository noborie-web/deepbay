import { beforeEach, describe, expect, it, vi } from 'vitest'

// ユーザー要望(2026-10-11): 「今後は必ず在庫管理できるようにしてください」
// CSV出品はeBayがItemIDを返さないため、出品時に在庫管理へ登録できない。
// 取り込みを忘れると管理外の出品が静かに増える(2026-10-08時点で626件)。
// 自動登録は原理的に不可能なので、未登録を検知して知らせる。
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { GET } from '@/app/api/inventory/csv-listed-status/route'

function makeDb(
  candidates: Array<Record<string, unknown>>,
  managedProductIds: string[],
  captured?: { productFilters: Array<[string, unknown]> },
) {
  return {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        not: (column: string, op: string, value: unknown) => {
          if (table === 'products') captured?.productFilters.push([column, `${op}:${value}`])
          return query
        },
        is: (column: string, value: unknown) => {
          if (table === 'products') captured?.productFilters.push([column, value])
          return query
        },
        order: () => query,
        in: async () => ({ data: managedProductIds.map((id) => ({ product_id: id })), error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: table === 'products' ? candidates : [], error: null }).then(resolve),
      }
      return query
    },
  }
}

const product = (id: string) => ({
  id, ebay_title: `Item ${id}`, original_title: `元 ${id}`,
  listing_csv_exported_at: '2026-10-11T00:00:00.000Z',
})

describe('CSV出品した商品の在庫管理の状況', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('在庫管理に入っていない件数を返す', async () => {
    mocks.createServiceClient.mockReturnValue(makeDb([product('p1'), product('p2'), product('p3')], ['p2']))

    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.pending).toBe(2)
    expect(json.items.map((item: { id: string }) => item.id)).toEqual(['p1', 'p3'])
  })

  it('全部取り込み済みなら0件', async () => {
    mocks.createServiceClient.mockReturnValue(makeDb([product('p1')], ['p1']))

    const json = await (await GET()).json()
    expect(json.pending).toBe(0)
  })

  it('対象の商品が無ければ照会もしない', async () => {
    mocks.createServiceClient.mockReturnValue(makeDb([], []))

    const json = await (await GET()).json()
    expect(json).toEqual({ pending: 0, items: [], lastExportedAt: null })
  })

  it('出品CSVに出していて、かつItemIDが分かっていない商品だけを対象にする', async () => {
    const captured = { productFilters: [] as Array<[string, unknown]> }
    mocks.createServiceClient.mockReturnValue(makeDb([product('p1')], [], captured))

    await GET()

    expect(captured.productFilters).toContainEqual(['listing_csv_exported_at', 'is:null'])
    expect(captured.productFilters).toContainEqual(['ebay_item_id', null])
  })

  it('未ログインなら拒否する', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET()
    expect(res.status).toBe(401)
  })
})
