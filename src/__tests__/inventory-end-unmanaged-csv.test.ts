import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー判断(2026-10-09): 商品レコードが失われた出品(626件・在庫1以上・
// 総額約18万ドル)は仕入先URLが無く、売り切れを検知できないまま売れてしまう
// ため取り下げる。通常の取り下げは「仕入先が売り切れ(在庫0)」が条件なので
// 対象にならない。商品データが無い出品そのものを対象にする出力を用意する。
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { GET } from '@/app/api/inventory/actions/export-csv/route'

function makeDb(captured: { listingFilters: Array<[string, unknown]> }, listings: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      if (table === 'seller_accounts') {
        const query = {
          select: () => query,
          eq: () => query,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({
            data: [{ id: 'seller-a', seller_id: 'miyabi-24', display_name: null, is_default: true }],
            error: null,
          }).then(resolve),
        }
        return query
      }
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { captured.listingFilters.push([column, value]); return query },
        is: (column: string, value: unknown) => { captured.listingFilters.push([column, value]); return query },
        not: (column: string, op: string, value: unknown) => { captured.listingFilters.push([column, `${op}:${value}`]); return query },
        lte: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: listings, error: null }).then(resolve),
      }
      return query
    },
  }
}

function request(kind: string) {
  return new NextRequest(`http://localhost/api/inventory/actions/export-csv?kind=${kind}`)
}

describe('商品データが無い出品の取り下げCSV', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('商品に紐付かない出品だけを対象にする', async () => {
    const captured = { listingFilters: [] as Array<[string, unknown]> }
    mocks.createServiceClient.mockReturnValue(makeDb(captured, [
      { ebay_item_id: '298731296336', site_id: 'US', seller_account_id: 'seller-a' },
      { ebay_item_id: '377542536159', site_id: 'US', seller_account_id: 'seller-a' },
    ]))

    const res = await GET(request('end-unmanaged'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.count).toBe(2)
    // 商品が「無い」ものを選ぶ(通常の取り下げは「有る」ものを選ぶ)
    expect(captured.listingFilters).toContainEqual(['product_id', null])
    // 取り下げ済みは除く
    expect(captured.listingFilters).toContainEqual(['delisted_at', null])
  })

  it('EndのCSVとして、ItemIDごとに1行出力する', async () => {
    const captured = { listingFilters: [] as Array<[string, unknown]> }
    mocks.createServiceClient.mockReturnValue(makeDb(captured, [
      { ebay_item_id: '298731296336', site_id: 'US', seller_account_id: 'seller-a' },
    ]))

    const res = await GET(request('end-unmanaged'))
    const json = await res.json()

    expect(json.files).toHaveLength(1)
    expect(json.files[0].csv).toContain('298731296336')
    expect(json.files[0].csv).toContain('End')
  })

  it('対象が無ければ0件で返す', async () => {
    const captured = { listingFilters: [] as Array<[string, unknown]> }
    mocks.createServiceClient.mockReturnValue(makeDb(captured, []))

    const res = await GET(request('end-unmanaged'))
    const json = await res.json()

    expect(json.count).toBe(0)
    expect(json.files).toEqual([])
  })

  it('知らない kind は拒否する', async () => {
    mocks.createServiceClient.mockReturnValue(makeDb({ listingFilters: [] }, []))

    const res = await GET(request('unknown'))
    expect(res.status).toBe(400)
  })
})
