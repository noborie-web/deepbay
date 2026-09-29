import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-09-29): 出品アカウントを複数運用しているため、CSV取込でも
// 「どのセラーの、どのサイトの出品か」を指定できるようにする。指定しないと
// 他セラーの在庫スナップショットまで置き換えてしまう。
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))
vi.mock('@/lib/inventory-sync', () => ({ applyListingStateToProducts: vi.fn(async () => {}) }))

import { POST } from '@/app/api/inventory/upload/route'

const PRODUCT_ID = 'abcdef01-0000-4000-8000-000000000000'
const CSV = [
  'Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity',
  `111,kakehashi_${PRODUCT_ID.replace(/-/g, '_')},UK item,82.24,1,0`,
].join('\n')

function makeDb(captured: { deleteFilters: Array<[string, unknown]>; rows: Record<string, unknown>[] }) {
  return {
    from(table: string) {
      if (table === 'seller_accounts') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) chain[m] = () => chain
        chain.maybeSingle = async () => ({ data: { id: 'seller-b' }, error: null })
        return chain
      }
      if (table === 'inventory_runs') {
        const chain: Record<string, unknown> = {}
        chain.insert = () => chain
        chain.select = () => chain
        chain.single = async () => ({ data: { id: 'run-1' }, error: null })
        chain.update = () => ({ eq: async () => ({ error: null }) })
        return chain
      }
      if (table === 'products') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.in = async (column: string, values: string[]) => ({
          data: column === 'id' ? values.map(id => ({ id })) : [],
          error: null,
        })
        chain.update = () => ({ eq: () => ({ in: async () => ({ error: null }) }) })
        return chain
      }
      const chain: Record<string, unknown> = {}
      chain.delete = () => chain
      chain.eq = (column: string, value: unknown) => { captured.deleteFilters.push([column, value]); return chain }
      chain.upsert = async (rows: Record<string, unknown>[]) => { captured.rows.push(...rows); return { error: null } }
      chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
      return chain
    },
  }
}

function uploadRequest(query: string) {
  const form = new FormData()
  form.set('file', new File([CSV], 'active.csv', { type: 'text/csv' }))
  return new NextRequest(`http://localhost/api/inventory/upload${query}`, { method: 'POST', body: form })
}

describe('在庫CSV取込のセラー・サイト指定', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('セラーとサイトを指定すると、その範囲だけ置き換えて取り込む', async () => {
    const captured = { deleteFilters: [] as Array<[string, unknown]>, rows: [] as Record<string, unknown>[] }
    mocks.createServiceClient.mockReturnValue(makeDb(captured))

    const res = await POST(uploadRequest('?sellerAccountId=seller-b&siteId=UK'))
    expect(res.status).toBe(200)

    // 置き換えはそのセラー・そのサイトに限定される
    expect(captured.deleteFilters).toEqual([
      ['user_id', 'user-1'],
      ['seller_account_id', 'seller-b'],
      ['site_id', 'UK'],
    ])
    expect(captured.rows[0]).toMatchObject({
      ebay_item_id: '111',
      seller_account_id: 'seller-b',
      site_id: 'UK',
      currency: 'GBP',
    })
  })

  it('セラー未指定なら従来どおりユーザー全体を置き換える', async () => {
    const captured = { deleteFilters: [] as Array<[string, unknown]>, rows: [] as Record<string, unknown>[] }
    mocks.createServiceClient.mockReturnValue(makeDb(captured))

    await POST(uploadRequest(''))

    expect(captured.deleteFilters).toEqual([['user_id', 'user-1']])
    expect(captured.rows[0]).not.toHaveProperty('seller_account_id')
  })
})
