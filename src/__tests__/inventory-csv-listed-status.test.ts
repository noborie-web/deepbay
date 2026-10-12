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

import { GET, POST } from '@/app/api/inventory/csv-listed-status/route'

function makeDb(
  candidates: Array<Record<string, unknown>>,
  managedProductIds: string[],
  captured?: { productFilters: Array<[string, unknown]>; updates?: Array<Record<string, unknown>> },
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
        update: (payload: Record<string, unknown>) => { captured?.updates?.push(payload); return query },
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

import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-12): eBayに弾かれて出品されなかった商品(10/11は
// Durability Guarantee の値不正などで12件)は、確認済みにして警告から
// 外せるようにする。放置すると警告が消えず、新しい漏れに気づけなくなる。
describe('出品されなかったと確認済みにする', () => {
  function confirmRequest(body: Record<string, unknown> = {}) {
    return new NextRequest('http://localhost/api/inventory/csv-listed-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('確認日時を記録し、件数を返す', async () => {
    const captured = { productFilters: [] as Array<[string, unknown]>, updates: [] as Array<Record<string, unknown>> }
    mocks.createServiceClient.mockReturnValue(makeDb([product('p1'), product('p2')], [], captured))

    const res = await POST(confirmRequest())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.confirmed).toBe(2)
    expect(captured.updates[0].listing_csv_unlisted_confirmed_at).toBeTruthy()
  })

  it('既に確認済みのものは対象にしない(二重に数えない)', async () => {
    const captured = { productFilters: [] as Array<[string, unknown]>, updates: [] as Array<Record<string, unknown>> }
    mocks.createServiceClient.mockReturnValue(makeDb([product('p1')], [], captured))

    await POST(confirmRequest())

    expect(captured.productFilters).toContainEqual(['listing_csv_unlisted_confirmed_at', null])
  })

  it('未ログインなら拒否する', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    mocks.createServiceClient.mockReturnValue(makeDb([], []))

    const res = await POST(confirmRequest())
    expect(res.status).toBe(401)
  })

  it('確認済みの商品は、未登録の集計から外れる', async () => {
    const captured = { productFilters: [] as Array<[string, unknown]> }
    mocks.createServiceClient.mockReturnValue(makeDb([product('p1')], [], captured))

    await GET()

    expect(captured.productFilters).toContainEqual(['listing_csv_unlisted_confirmed_at', null])
  })
})
