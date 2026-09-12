import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { GET, PUT } from '@/app/api/price-tier-settings/route'

function request(method: 'PUT', body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/price-tier-settings', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeDatabase(returnData: Record<string, unknown> | null) {
  const states: Array<{ payload?: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  return {
    states,
    db: {
      from() {
        const state: { payload?: Record<string, unknown>; filters: Array<[string, unknown]> } = { filters: [] }
        const finish = () => {
          states.push({ ...state, filters: [...state.filters] })
          return Promise.resolve({ data: returnData, error: null })
        }
        const query = {
          select() { return query },
          eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
          upsert(payload: Record<string, unknown>) { state.payload = payload; return query },
          maybeSingle: finish,
          single: finish,
        }
        return query
      },
    },
  }
}

describe('price tier settings API', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('GET returns null when nothing saved yet', async () => {
    const { db } = makeDatabase(null)
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.setting).toBeNull()
  })

  it('GET returns the saved setting scoped to the authenticated user', async () => {
    const saved = { id: 'pt-1', user_id: 'user-1', tiers: [{ maxPurchaseJpy: null, profitJpy: 1000 }] }
    const { db, states } = makeDatabase(saved)
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.setting).toEqual(saved)
    expect(states[0].filters).toEqual(expect.arrayContaining([['user_id', 'user-1']]))
  })

  it('PUT upserts the tiers and cost fields for the authenticated user', async () => {
    const saved = { id: 'pt-1', user_id: 'user-1' }
    const { db, states } = makeDatabase(saved)
    mocks.createServiceClient.mockReturnValue(db)

    const response = await PUT(request('PUT', {
      tiers: [
        { maxPurchaseJpy: 5000, profitJpy: 2000 },
        { maxPurchaseJpy: null, profitJpy: 8000 },
      ],
      ebay_fee_rate: 0.15,
      shipping_jpy: 1800,
      fixed_cost_usd: 1,
      ad_rate: 0.04,
      customs_rate: 0,
      discount_rate: 0,
    }))

    expect(response.status).toBe(200)
    expect(states[0].payload).toMatchObject({
      user_id: 'user-1',
      tiers: [
        { maxPurchaseJpy: 5000, profitJpy: 2000 },
        { maxPurchaseJpy: null, profitJpy: 8000 },
      ],
      ebay_fee_rate: 0.15,
      shipping_jpy: 1800,
    })
  })

  it('PUT rejects an empty tier list', async () => {
    const response = await PUT(request('PUT', { tiers: [] }))
    expect(response.status).toBe(400)
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('PUT rejects tiers with non-numeric profitJpy', async () => {
    const response = await PUT(request('PUT', {
      tiers: [{ maxPurchaseJpy: null, profitJpy: 'not-a-number' }],
    }))
    expect(response.status).toBe(400)
  })
})
