import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { getDelistCutoffIso, isDelistByAgeEnabled, normalizeDaysUntilDelist, resolveDelistEligibility } from '@/lib/inventory-delist'

let mockUser: { id: string } | null = { id: 'user-1' }
let mockListings: Array<{ ebay_item_id: string; product_id: string | null; quantity: number; start_time: string }> = []
let mockDelistByAgeEnabled: boolean | undefined = true
let mockDelistOnSoldOut: boolean | undefined = false
const mockIs = vi.fn()
const mockUpdate = vi.fn()
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
        // 経過日数モードでは .lte(...) が、即取り下げモードでは .is(...) が
        // 末尾になるため、チェーン自体を await 可能(thenable)にする。
        const query: Record<string, unknown> = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: mockIn.mockReturnThis(),
          is: mockIs.mockReturnThis(),
          lte: mockLte.mockReturnThis(),
          update: mockUpdate.mockImplementation(() => ({
            eq: () => ({ in: () => ({ select: async () => ({ data: [{ product_id: 'product-1' }], error: null }) }) }),
          })),
        }
        query.then = (resolve: (v: unknown) => void) => resolve({ data: mockListings, error: null })
        return query
      }
      // 出品アカウント経由の接続なし(従来どおり単一トークンで動く)
      if (table === 'seller_accounts') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'not', 'order', 'update']) chain[m] = vi.fn(() => chain)
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        return chain
      }
      if (table === 'inventory_settings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({
            data: { ebay_token: 'token', ebay_refresh_token: null, ebay_token_expires_at: null, days_until_delist: 29, delist_by_age_enabled: mockDelistByAgeEnabled, delist_on_sold_out: mockDelistOnSoldOut },
            error: null,
          })),
        }
      }
      if (table === 'products') {
        return { update: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }) }
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
  resolveSellerAccountAccessToken: vi.fn(async () => 'access-token'),
}))

describe('/api/inventory/actions/delist', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1' }
    mockListings = []
    mockDelistByAgeEnabled = true
    mockDelistOnSoldOut = false
    mockIn.mockClear()
    mockIs.mockClear()
    mockUpdate.mockClear()
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

  // ユーザー要望: 「N日経過取り下げ」をOFFにしたら経過日数による取り下げを
  // 中止する(売り切れ商品を即取り下げるのではなく、取り下げ自体を行わない)。
  it('N日経過取り下げがOFFならプレビューは対象0件を返し、一覧を問い合わせない', async () => {
    mockDelistByAgeEnabled = false
    mockListings = [{ ebay_item_id: 'item-1', product_id: null, quantity: 0, start_time: '2026-07-01T00:00:00.000Z' }]
    const { GET } = await import('@/app/api/inventory/actions/delist/route')
    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ count: 0, items: [], disabled: true })
    expect(mockLte).not.toHaveBeenCalled()
  })

  it('N日経過取り下げがOFFなら実行を拒否し、eBayへ一切アクセスしない', async () => {
    mockDelistByAgeEnabled = false
    const { POST } = await import('@/app/api/inventory/actions/delist/route')
    const res = await POST(request({ item_ids: ['item-1'] }))

    expect(res.status).toBe(409)
    expect(mockResolveAccessToken).not.toHaveBeenCalled()
    expect(mockEndItem).not.toHaveBeenCalled()
    expect(mockReviseQuantityToZero).not.toHaveBeenCalled()
  })

  // ユーザー要望: 「仕入先が売り切れたら即取り下げ(N日経過を待たない)」。
  it('売り切れ即取り下げがONなら経過日数で絞らず、在庫0の商品を対象にする', async () => {
    mockDelistOnSoldOut = true
    mockDelistByAgeEnabled = false
    mockListings = [{ ebay_item_id: 'item-1', product_id: 'product-1', quantity: 0, start_time: '2026-08-09T00:00:00.000Z' }]
    const { GET } = await import('@/app/api/inventory/actions/delist/route')
    const res = await GET()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ count: 1, immediate: true })
    expect(mockLte).not.toHaveBeenCalled()
    // 取り下げ済みの出品は対象にしない
    expect(mockIs).toHaveBeenCalledWith('delisted_at', null)
  })

  it('売り切れ即取り下げがONなら実行時も経過日数で絞らず、実行後に取り下げ済みを記録する', async () => {
    mockDelistOnSoldOut = true
    mockListings = [{ ebay_item_id: 'item-1', product_id: 'product-1', quantity: 0, start_time: '2026-08-09T00:00:00.000Z' }]
    mockReviseQuantityToZero.mockResolvedValue({ itemId: 'item-1', success: true })
    const { POST } = await import('@/app/api/inventory/actions/delist/route')
    const res = await POST(request({ item_ids: ['item-1'] }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, total: 1, succeeded: 1 })
    expect(mockLte).not.toHaveBeenCalled()
    expect(mockReviseQuantityToZero).toHaveBeenCalledWith('access-token', 'item-1', 'US')
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ delisted_at: expect.any(String) }))
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
    expect(mockEndItem).toHaveBeenCalledWith('access-token', 'item-1', 'US')
    expect(mockReviseQuantityToZero).toHaveBeenCalledWith('access-token', 'item-2', 'US')
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

describe('isDelistByAgeEnabled', () => {
  it('未設定・nullは従来どおりONとして扱う', () => {
    expect(isDelistByAgeEnabled(undefined)).toBe(true)
    expect(isDelistByAgeEnabled(null)).toBe(true)
    expect(isDelistByAgeEnabled({})).toBe(true)
    expect(isDelistByAgeEnabled({ delist_by_age_enabled: null })).toBe(true)
  })

  it('明示的にfalseのときだけOFFになる', () => {
    expect(isDelistByAgeEnabled({ delist_by_age_enabled: false })).toBe(false)
    expect(isDelistByAgeEnabled({ delist_by_age_enabled: true })).toBe(true)
  })
})

describe('resolveDelistEligibility', () => {
  const now = new Date('2026-08-10T00:00:00.000Z')

  it('売り切れ即取り下げがONなら経過日数を使わない', () => {
    expect(resolveDelistEligibility({ delist_on_sold_out: true, delist_by_age_enabled: false, days_until_delist: 29 }, now))
      .toEqual({ enabled: true, immediate: true, cutoffIso: null })
  })

  it('OFFならN日経過取り下げの設定に従う', () => {
    expect(resolveDelistEligibility({ delist_on_sold_out: false, delist_by_age_enabled: true, days_until_delist: 29 }, now))
      .toEqual({ enabled: true, immediate: false, cutoffIso: '2026-07-12T00:00:00.000Z' })
    expect(resolveDelistEligibility({ delist_on_sold_out: false, delist_by_age_enabled: false }, now))
      .toEqual({ enabled: false, immediate: false, cutoffIso: null })
  })

  it('未設定は従来どおり(N日経過ON・即取り下げOFF)として扱う', () => {
    expect(resolveDelistEligibility(undefined, now).immediate).toBe(false)
    expect(resolveDelistEligibility(undefined, now).enabled).toBe(true)
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
