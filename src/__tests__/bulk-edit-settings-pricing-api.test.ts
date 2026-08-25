import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface State {
  operation: 'insert' | 'update' | null
  payload?: Record<string, unknown>
  filters: Array<[string, unknown]>
}

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { PATCH, POST } from '@/app/api/bulk-edit-settings/route'

function request(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/bulk-edit-settings', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeDatabase(returnData: Record<string, unknown> | null) {
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
          select() { return query },
          eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
          single: finish,
          maybeSingle: finish,
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
})
