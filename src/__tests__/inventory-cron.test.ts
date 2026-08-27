import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mockResolveAccessToken = vi.fn()
const mockSyncInventoryListings = vi.fn()
const mockCheckSupplierListings = vi.fn()
const mockRunInsert = vi.fn()
let mockSettings: Array<Record<string, unknown>> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_settings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(async () => ({
            data: mockSettings,
            error: null,
          })),
        }
      }
      if (table === 'inventory_runs') {
        return { insert: mockRunInsert.mockImplementation(async () => ({ error: null })) }
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  })),
}))

vi.mock('@/lib/inventory-sync', () => ({
  syncInventoryListings: mockSyncInventoryListings,
}))

vi.mock('@/lib/inventory-supplier-check', () => ({
  checkSupplierListings: mockCheckSupplierListings,
}))

vi.mock('@/lib/ebay-actions', () => ({
  endItem: vi.fn(),
  reviseQuantityToZero: vi.fn(),
  revisePrice: vi.fn(),
  addFixedPriceItem: vi.fn(),
}))

vi.mock('@/lib/inventory-auth', () => ({
  resolveInventoryAccessToken: mockResolveAccessToken,
}))

describe('GET /api/cron/inventory-auto', () => {
  const originalSecret = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret'
    mockSettings = [{
      user_id: 'user-1',
      ebay_token: 'token',
      ebay_refresh_token: null,
      ebay_token_expires_at: null,
      ebay_auto_sync: true,
      auto_delist: false,
      auto_revise_price: false,
      auto_stack: false,
      days_until_delist: 29,
      payment_profile_name: null,
      return_profile_name: null,
      shipping_profile_name: null,
    }]
    mockResolveAccessToken.mockReset().mockResolvedValue('access-token')
    mockSyncInventoryListings.mockReset().mockResolvedValue({ total: 12, matched: 8 })
    mockCheckSupplierListings.mockReset().mockResolvedValue({
      total: 2,
      available: 1,
      unavailable: 1,
      skipped: 0,
      failed: 0,
    })
    mockRunInsert.mockClear()
  })

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret
  })

  it('processes enabled users whenever the daily Vercel cron invokes the route', async () => {
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: 1 })
    expect(mockResolveAccessToken).toHaveBeenCalledOnce()
    expect(mockSyncInventoryListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 'access-token')
    expect(mockCheckSupplierListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 50)
    expect(mockSyncInventoryListings.mock.invocationCallOrder[0]).toBeLessThan(
      mockCheckSupplierListings.mock.invocationCallOrder[0],
    )
    expect(json.results[0].supplier_check).toMatchObject({ total: 2, unavailable: 1 })
    expect(mockRunInsert).toHaveBeenCalledWith(expect.objectContaining({
      run_type: 'sync',
      status: 'completed',
      items_total: 12,
      items_matched: 8,
    }))
  })

  it('stops later inventory actions when automatic sync fails', async () => {
    mockSyncInventoryListings.mockRejectedValue(new Error('sync failed'))
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.results[0].sync).toEqual({ error: 'sync failed' })
    expect(mockCheckSupplierListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 50)
    expect(mockRunInsert).toHaveBeenCalledWith(expect.objectContaining({
      run_type: 'sync',
      status: 'failed',
      error_message: 'sync failed',
    }))
  })

  it('continues with the next user when token resolution fails', async () => {
    mockSettings = [
      { ...mockSettings[0], user_id: 'user-1' },
      { ...mockSettings[0], user_id: 'user-2', ebay_token: 'token-2' },
    ]
    mockResolveAccessToken
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce('access-token-2')

    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: 2 })
    expect(json.results[0].auth).toEqual({ error: 'refresh failed' })
    expect(mockSyncInventoryListings).toHaveBeenCalledTimes(1)
    expect(mockSyncInventoryListings).toHaveBeenCalledWith(expect.anything(), 'user-2', 'access-token-2')
    expect(mockRunInsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user-1',
      status: 'failed',
      error_message: 'トークン取得失敗: refresh failed',
    }))
    expect(mockCheckSupplierListings).toHaveBeenCalledTimes(2)
  })

  it('checks suppliers without resolving an eBay token when all automatic actions are disabled', async () => {
    mockSettings = [{
      ...mockSettings[0],
      ebay_auto_sync: false,
      auto_delist: false,
      auto_revise_price: false,
      auto_stack: false,
    }]

    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(json).toMatchObject({ ok: true, processed: 1 })
    expect(mockResolveAccessToken).not.toHaveBeenCalled()
    expect(mockCheckSupplierListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 50)
  })

  it('is configured for one daily invocation at midnight UTC', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))

    expect(config.crons).toContainEqual({
      path: '/api/cron/inventory-auto',
      schedule: '0 0 * * *',
    })
  })
})
