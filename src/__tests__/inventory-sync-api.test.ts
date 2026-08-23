import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockExpireStaleRuns,
  mockResolveAccessToken,
  mockRunInsert,
  mockRunSelect,
  mockRunUpdate,
  mockListingCountSelect,
  mockProductEq,
  mockProductLimit,
  mockSyncBatch,
} = vi.hoisted(() => ({
  mockExpireStaleRuns: vi.fn(),
  mockResolveAccessToken: vi.fn(),
  mockRunInsert: vi.fn(),
  mockRunSelect: vi.fn(),
  mockRunUpdate: vi.fn(),
  mockListingCountSelect: vi.fn(),
  mockProductEq: vi.fn(),
  mockProductLimit: vi.fn(),
  mockSyncBatch: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
  })),
}))

vi.mock('@/lib/inventory-auth', () => ({
  resolveInventoryAccessToken: mockResolveAccessToken,
}))

vi.mock('@/lib/inventory-run', () => ({
  expireStaleInventorySyncRuns: mockExpireStaleRuns,
}))

vi.mock('@/lib/inventory-sync', () => ({
  syncInventoryListingBatch: mockSyncBatch,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_settings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({
            data: { ebay_token: 'token' },
            error: null,
          })),
        }
      }
      if (table === 'inventory_runs') {
        return {
          insert: mockRunInsert,
          select: mockRunSelect,
          update: mockRunUpdate,
        }
      }
      if (table === 'inventory_active_listings') {
        return {
          delete: vi.fn().mockReturnValue(updateQuery()),
          select: mockListingCountSelect,
        }
      }
      if (table === 'products') {
        const query = {
          select: vi.fn(),
          eq: mockProductEq,
          limit: mockProductLimit,
        }
        query.select.mockReturnValue(query)
        mockProductEq.mockReturnValue(query)
        return query
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  })),
}))

function updateQuery() {
  return { eq: vi.fn(async () => ({ error: null })) }
}

describe('POST /api/inventory/sync', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret'
    mockExpireStaleRuns.mockReset().mockResolvedValue(undefined)
    mockResolveAccessToken.mockReset().mockResolvedValue('access-token')
    mockSyncBatch.mockReset()
    mockRunUpdate.mockReset().mockImplementation(() => updateQuery())
    mockRunInsert.mockReset().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        single: vi.fn(async () => ({ data: { id: 'run-1' }, error: null })),
      }),
    }))
    mockRunSelect.mockReset()
    mockListingCountSelect.mockReset().mockImplementation(() => ({
      eq: vi.fn(async () => ({ count: 1050, error: null })),
    }))
    mockProductEq.mockReset()
    mockProductLimit.mockReset()
  })

  it('starts a run and returns a signed continuation cursor', async () => {
    mockSyncBatch.mockResolvedValue({
      total: 600,
      matched: 10,
      nextPage: 5,
      totalPages: 25,
      lastFetchedPage: 4,
    })

    const { POST } = await import('@/app/api/inventory/sync/route')
    const response = await POST(new Request('http://localhost/api/inventory/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json).toMatchObject({
      ok: true,
      total: 600,
      matched: 10,
      done: false,
      progress: { page: 4, totalPages: 25 },
    })
    expect(json.cursor).toEqual(expect.any(String))
    expect(mockSyncBatch).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'access-token',
      1,
      4,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('uses the stored unique listing count when the run completes', async () => {
    mockSyncBatch
      .mockResolvedValueOnce({
        total: 600, matched: 10, nextPage: 5, totalPages: 8, lastFetchedPage: 4,
      })
      .mockResolvedValueOnce({
        total: 550, matched: 8, nextPage: null, totalPages: 8, lastFetchedPage: 8,
      })

    const { POST } = await import('@/app/api/inventory/sync/route')
    const firstResponse = await POST(new Request('http://localhost/api/inventory/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))
    const firstJson = await firstResponse.json()

    const existingRunQuery = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({
        data: { id: 'run-1', status: 'running', items_total: 600, items_matched: 10 },
        error: null,
      })),
    }
    mockRunSelect.mockReturnValue(existingRunQuery)

    const secondResponse = await POST(new Request('http://localhost/api/inventory/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: firstJson.cursor }),
    }))
    const secondJson = await secondResponse.json()

    expect(secondResponse.status).toBe(200)
    expect(secondJson).toEqual({
      ok: true,
      total: 1050,
      matched: 18,
      done: true,
      cursor: null,
      progress: { page: 8, totalPages: 8 },
    })
    expect(mockSyncBatch).toHaveBeenLastCalledWith(
      expect.anything(),
      'user-1',
      'access-token',
      5,
      4,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mockRunInsert).toHaveBeenCalledTimes(1)
    expect(mockListingCountSelect).toHaveBeenCalledWith('id', { count: 'exact', head: true })
    expect(mockRunUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'completed',
      items_total: 1050,
    }))
  })

  it('falls back to the fetched total if the unique count cannot be read', async () => {
    mockSyncBatch.mockResolvedValue({
      total: 550, matched: 8, nextPage: null, totalPages: 4, lastFetchedPage: 4,
    })
    mockListingCountSelect.mockImplementation(() => ({
      eq: vi.fn(async () => ({ count: null, error: { message: 'count failed' } })),
    }))

    const { POST } = await import('@/app/api/inventory/sync/route')
    const response = await POST(new Request('http://localhost/api/inventory/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      total: 550,
      done: true,
    })
  })

  it('rejects a modified continuation cursor', async () => {
    const { POST } = await import('@/app/api/inventory/sync/route')
    const response = await POST(new Request('http://localhost/api/inventory/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor: 'changed.invalid' }),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: '同期の継続情報が無効です。最初からやり直してください。',
    })
    expect(mockSyncBatch).not.toHaveBeenCalled()
  })
})

describe('GET /api/inventory/matching', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret'
    mockProductEq.mockReset()
    mockProductLimit.mockReset().mockResolvedValue({
      data: [{ id: 'product-1', source_item_id: 'deepbay_source-uuid' }],
      error: null,
    })
  })

  it('finds an exact source_item_id match', async () => {
    const { NextRequest } = await import('next/server')
    const { GET } = await import('@/app/api/inventory/matching/route')
    const response = await GET(new NextRequest(
      'http://localhost/api/inventory/matching?sourceItemId=deepbay_source-uuid',
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      products: [{ id: 'product-1', source_item_id: 'deepbay_source-uuid' }],
    })
    expect(mockProductEq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(mockProductEq).toHaveBeenCalledWith('source_item_id', 'deepbay_source-uuid')
    expect(mockProductLimit).toHaveBeenCalledWith(2)
  })
})
