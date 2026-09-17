import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望: 段階利益の設定を「デフォルト設定1(控えめ)」「デフォルト設定2
// (積極)」のように名前を付けて複数保存し、切り替えて使えるようにする。
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { DELETE, GET, PUT } from '@/app/api/price-tier-presets/route'

const tiers = [
  { maxPurchaseJpy: 5000, profitJpy: 1800 },
  { maxPurchaseJpy: 20000, profitJpy: 3500 },
  { maxPurchaseJpy: null, profitJpy: 8000 },
]

function put(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/price-tier-presets', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

interface State { op: string; payload?: Record<string, unknown>; filters: Array<[string, unknown]> }

function makeDatabase(options: { presets?: Array<Record<string, unknown>>; existing?: Record<string, unknown> | null; count?: number }) {
  const states: State[] = []
  const db = {
    from() {
      const state: State = { op: 'select', filters: [] }
      const query = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) { if (opts?.head) state.op = 'count'; return query },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
        order() { states.push(state); return Promise.resolve({ data: options.presets ?? [], error: null }) },
        upsert(payload: Record<string, unknown>) { state.op = 'upsert'; state.payload = payload; return query },
        delete() { state.op = 'delete'; return query },
        maybeSingle() { states.push(state); return Promise.resolve({ data: options.existing ?? null, error: null }) },
        single() { states.push(state); return Promise.resolve({ data: { id: 'preset-1', ...state.payload }, error: null }) },
        then(resolve: (v: unknown) => void) {
          states.push(state)
          resolve(state.op === 'count' ? { count: options.count ?? 0, error: null } : { error: null })
        },
      }
      return query
    },
  }
  return { db, states }
}

describe('price tier presets API', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('GET はユーザーのプリセット一覧を返す', async () => {
    const { db } = makeDatabase({ presets: [{ id: 'p1', name: 'デフォルト設定1' }] })
    mocks.createServiceClient.mockReturnValue(db)

    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).presets).toEqual([{ id: 'p1', name: 'デフォルト設定1' }])
  })

  it('PUT は名前付きで保存し、同名なら上書きする(user_id,name で upsert)', async () => {
    const { db, states } = makeDatabase({ existing: null, count: 1 })
    mocks.createServiceClient.mockReturnValue(db)

    const res = await PUT(put({ name: ' デフォルト設定1 ', tiers, ebay_fee_rate: 0.15, shipping_jpy: 6000, ad_rate: 0.04, customs_rate: 0.13, discount_rate: 0.05 }))

    expect(res.status).toBe(200)
    const upsert = states.find((s) => s.op === 'upsert')!
    expect(upsert.payload).toMatchObject({ user_id: 'user-1', name: 'デフォルト設定1', tiers, ebay_fee_rate: 0.15, shipping_jpy: 6000, ad_rate: 0.04 })
    expect((await res.json()).preset.name).toBe('デフォルト設定1')
  })

  it('PUT は設定名が空・価格帯が不正なら 400', async () => {
    mocks.createServiceClient.mockReturnValue(makeDatabase({}).db)
    expect((await PUT(put({ name: '', tiers }))).status).toBe(400)
    expect((await PUT(put({ name: 'x', tiers: [{ maxPurchaseJpy: 5000, profitJpy: 1000 }, { maxPurchaseJpy: 3000, profitJpy: 2000 }, { maxPurchaseJpy: null, profitJpy: 3000 }] }))).status).toBe(400)
  })

  it('PUT は上限件数を超える新規作成を拒否する(既存名の上書きは可)', async () => {
    mocks.createServiceClient.mockReturnValue(makeDatabase({ existing: null, count: 20 }).db)
    expect((await PUT(put({ name: 'new', tiers }))).status).toBe(400)
    mocks.createServiceClient.mockReturnValue(makeDatabase({ existing: { id: 'p1' }, count: 20 }).db)
    expect((await PUT(put({ name: 'existing', tiers }))).status).toBe(200)
  })

  it('DELETE は自分のプリセットだけを削除する', async () => {
    const { db, states } = makeDatabase({})
    mocks.createServiceClient.mockReturnValue(db)

    const res = await DELETE(new NextRequest('http://localhost/api/price-tier-presets?id=p1', { method: 'DELETE' }))

    expect(res.status).toBe(200)
    const del = states.find((s) => s.op === 'delete')!
    expect(del.filters).toEqual([['user_id', 'user-1'], ['id', 'p1']])
  })

  it('未認証は 401', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    expect((await GET()).status).toBe(401)
  })
})
