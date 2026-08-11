import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getDelistCutoffIso, normalizeDaysUntilDelist } from '@/lib/inventory-delist'

let mockUser: { id: string } | null = { id: 'user-1' }
let mockListings: Array<{ ebay_item_id: string; product_id: string | null; quantity: number; start_time: string }> = []
const mockIn = vi.fn()
const mockLte = vi.fn()
const mockEndItem = vi.fn()
const mockReviseQuantityToZero = vi.fn()
const mockResolveAccessToken = vi.fn()
const mockRunInsert = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockUser } })),
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_active_listings') {
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: mockIn.mockReturnThis(),
          lte: mockLte.mockImplementation(async () => ({ data: mockListings, error: null })),
        }
        return query
      }
      if (table === 'inventory_settings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({
            data: { ebay_token: 'token', ebay_refresh_token: null, ebay_token_expires_at: null, days_until_delist: 29 },
            error: null,
          })),
        }
      }
      return {
        insert: mockRunInsert.mockImplementation(async () => ({ error: null })),
      }
    }),
  })),
}))

vi.mock('@/lib/ebay-actions', () => ({
  endItem: mockEndItem,
  reviseQuantityToZero: mockReviseQuantityToZero,
}))

vi.mock('@/lib/inventory-auth', () => ({
  resolveInventoryAccessToken: mockResolveAccessToken,
}))

describe('/api/inventory/actions/delist', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1' }
    mockListings = []
    mockIn.mockClear()
    mockLte.mockClear()
    mockEndItem.mockReset()
    mockReviseQuantityToZero.mockReset()
    mockResolveAccessToken.mockReset().mockResolvedValue('access-token')
    mockRunInsert.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T00:00:00.000Z'))
  })

  afterEach(() => vi.useRealTimers())

  const request = (body: unknown) => new NextRequest('http://localhost/api/inventory/actions/delist', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  it('filters the preview by the configured elapsed days', async () => {
    mockListings = [{ ebay_item_id: 'item-1', product_id: null, quantity: 0, start_time: '2026-07-01T00:00:00.000Z' }]
    const { GET } = await import('@/app/api/inventory/actions/delist/route')
    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ count: 1 })
    expect(mockLte).toHaveBeenCalledWith('start_time', '2026-07-12T00:00:00.000Z')
  })

  it('rejects execution without previewed item IDs', async () => {
    const { POST } = await import('@/app/api/inventory/actions/delist/route')
    const res = await POST(request({}))

    expect(res.status).toBe(400)
    expect(mockIn).not.toHaveBeenCalled()
    expect(mockResolveAccessToken).not.toHaveBeenCalled()
  })

  it('stops before eBay execution when an item is no longer eligible', async () => {
    mockListings = [{ ebay_item_id: 'item-1', product_id: null, quantity: 0, start_time: '2026-07-01T00:00:00.000Z' }]
    const { POST } = await import('@/app/api/inventory/actions/delist/route')
    const res = await POST(request({ item_ids: ['item-1', 'item-2'] }))
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.item_ids).toEqual(['item-2'])
    expect(mockIn).toHaveBeenCalledWith('ebay_item_id', ['item-1', 'item-2'])
    expect(mockLte).toHaveBeenCalledWith('start_time', '2026-07-12T00:00:00.000Z')
    expect(mockResolveAccessToken).not.toHaveBeenCalled()
    expect(mockEndItem).not.toHaveBeenCalled()
  })

  it('executes only the confirmed eligible item IDs', async () => {
    mockListings = [
      { ebay_item_id: 'item-1', product_id: null, quantity: 0, start_time: '2026-07-01T00:00:00.000Z' },
      { ebay_item_id: 'item-2', product_id: 'product-2', quantity: 0, start_time: '2026-06-01T00:00:00.000Z' },
    ]
    mockEndItem.mockResolvedValue({ itemId: 'item-1', success: true })
    mockReviseQuantityToZero.mockResolvedValue({ itemId: 'item-2', success: true })
    const { POST } = await import('@/app/api/inventory/actions/delist/route')
    const res = await POST(request({ item_ids: [' item-1 ', 'item-2', 'item-2'] }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, total: 2, succeeded: 2 })
    expect(mockIn).toHaveBeenCalledWith('ebay_item_id', ['item-1', 'item-2'])
    expect(mockLte).toHaveBeenCalledWith('start_time', '2026-07-12T00:00:00.000Z')
    expect(mockEndItem).toHaveBeenCalledWith('access-token', 'item-1')
    expect(mockReviseQuantityToZero).toHaveBeenCalledWith('access-token', 'item-2')
  })

  it('records partial action failures using the DB-supported failed status', async () => {
    mockListings = [
      { ebay_item_id: 'item-1', product_id: null, quantity: 0, start_time: '2026-07-01T00:00:00.000Z' },
      { ebay_item_id: 'item-2', product_id: null, quantity: 0, start_time: '2026-06-01T00:00:00.000Z' },
    ]
    mockEndItem
      .mockResolvedValueOnce({ itemId: 'item-1', success: true })
      .mockResolvedValueOnce({ itemId: 'item-2', success: false, error: 'eBay rejected the action' })
    const { POST } = await import('@/app/api/inventory/actions/delist/route')
    const res = await POST(request({ item_ids: ['item-1', 'item-2'] }))

    expect(res.status).toBe(200)
    expect(mockRunInsert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error_message: '1/2件失敗: eBay rejected the action',
    }))
  })
})

describe('delist cutoff', () => {
  it('uses the configured number of elapsed days', () => {
    expect(getDelistCutoffIso(29, new Date('2026-08-10T00:00:00.000Z')))
      .toBe('2026-07-12T00:00:00.000Z')
  })

  it('normalizes unsafe values to the supported range', () => {
    expect(normalizeDaysUntilDelist(0)).toBe(1)
    expect(normalizeDaysUntilDelist(999)).toBe(365)
    expect(normalizeDaysUntilDelist(Number.NaN)).toBe(29)
  })
})
