import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  operation: 'insert' | 'update' | 'delete' | null
  payload?: Record<string, unknown>
  filters: Array<[string, unknown]>
}

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { DELETE, GET, PATCH, POST } from '@/app/api/bulk-edit-settings/route'

function request(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/bulk-edit-settings', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteRequest(id: string) {
  return new NextRequest(`http://localhost/api/bulk-edit-settings?id=${id}`, { method: 'DELETE' })
}

function makeDatabase(returnData: Record<string, unknown> | Record<string, unknown>[] | null, deleteCount = 1) {
  const states: State[] = []
  return {
    states,
    db: {
      from() {
        const state: State = { operation: null, filters: [] }
        const finish = () => {
          states.push({ ...state, filters: [...state.filters] })
          return Promise.resolve({ data: returnData, error: null })
        }
        const query = {
          insert(payload: Record<string, unknown>) { state.operation = 'insert'; state.payload = payload; return query },
          update(payload: Record<string, unknown>) { state.operation = 'update'; state.payload = payload; return query },
          delete() { state.operation = 'delete'; return query },
          select() { return query },
          eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
          neq(column: string, value: unknown) { state.filters.push([`neq:${column}`, value]); return query },
          order() { return finish() },
          single: finish,
          maybeSingle: finish,
          then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
            states.push({ ...state, filters: [...state.filters] })
            const value = state.operation === 'delete'
              ? { error: null, count: deleteCount }
              : { data: returnData, error: null }
            return Promise.resolve(value).then(onFulfilled, onRejected)
          },
        }
        return query
      },
    },
  }
}

describe('bulk edit setting automatic pricing API', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('creates nullable custom pricing fields for the authenticated user', async () => {
    const saved = { id: 'bulk-1', user_id: 'user-1', name: '自動価格' }
    const { db, states } = makeDatabase(saved)
    mocks.createServiceClient.mockReturnValue(db)
    const response = await POST(request('POST', {
      name: '自動価格',
      title_prefix: '[NEW] ',
      title_suffix: '',
      profit_rate: 0.23,
      ebay_fee_rate: 0.2,
      shipping_cost_jpy: 3000,
      fixed_cost_usd: null,
    }))

    expect(response.status).toBe(201)
    expect(states[0].payload).toMatchObject({
      user_id: 'user-1',
      profit_rate: 0.23,
      ebay_fee_rate: 0.2,
      shipping_cost_jpy: 3000,
      fixed_cost_usd: null,
    })
  })

  it('updates only a setting owned by the authenticated user', async () => {
    const { db, states } = makeDatabase({ id: 'bulk-1', name: '更新後' })
    mocks.createServiceClient.mockReturnValue(db)
    const response = await PATCH(request('PATCH', {
      id: 'bulk-1',
      name: '更新後',
      profit_rate: null,
      ebay_fee_rate: null,
      shipping_cost_jpy: null,
      fixed_cost_usd: null,
    }))

    expect(response.status).toBe(200)
    expect(states[0].filters).toEqual(expect.arrayContaining([
      ['id', 'bulk-1'],
      ['user_id', 'user-1'],
    ]))
  })

  it('rejects a fee and profit-rate total of 100% or more', async () => {
    const response = await POST(request('POST', {
      name: '不正設定',
      profit_rate: 0.6,
      ebay_fee_rate: 0.4,
    }))
    expect(response.status).toBe(400)
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('GET lists only the authenticated user\'s settings', async () => {
    const rows = [{ id: 'bulk-1' }, { id: 'bulk-2' }]
    const { db, states } = makeDatabase(rows)
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.settings).toEqual(rows)
    expect(states[0].filters).toEqual(expect.arrayContaining([['user_id', 'user-1']]))
  })

  it('DELETE removes only a setting owned by the authenticated user', async () => {
    const { db, states } = makeDatabase(null, 1)
    mocks.createServiceClient.mockReturnValue(db)

    const response = await DELETE(deleteRequest('bulk-1'))

    expect(response.status).toBe(200)
    expect(states[0].operation).toBe('delete')
    expect(states[0].filters).toEqual(expect.arrayContaining([
      ['id', 'bulk-1'],
      ['user_id', 'user-1'],
    ]))
  })

  it('DELETE returns 404 when nothing owned by the user matched', async () => {
    const { db } = makeDatabase(null, 0)
    mocks.createServiceClient.mockReturnValue(db)

    const response = await DELETE(deleteRequest('not-mine'))

    expect(response.status).toBe(404)
  })

  // ユーザー要望: 一括編集設定の「デフォルト使用設定」は次回ログイン時に
  // 自動選択される設定を1つに絞りたいため、有効にした設定以外の
  // is_defaultを自動的にfalseへ倒す。
  it('creates with is_default=true clears the flag on the user\'s other settings first', async () => {
    const saved = { id: 'bulk-new', user_id: 'user-1', name: '新デフォルト', is_default: true }
    const { db, states } = makeDatabase(saved)
    mocks.createServiceClient.mockReturnValue(db)

    await POST(request('POST', { name: '新デフォルト', is_default: true }))

    const clearOthers = states.find((s) => s.operation === 'update' && s.payload?.is_default === false)
    expect(clearOthers?.filters).toEqual(expect.arrayContaining([['user_id', 'user-1']]))
  })
})
