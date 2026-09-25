import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望: Yahoo!フリマの売り切れチェックを15分ごとに12件ずつ行い、
// 売り切れは自動取り下げ(売り切れ即取り下げON)でその場で在庫0にする。
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  revise: vi.fn(),
  markDelisted: vi.fn(async () => {}),
  resolveToken: vi.fn(async () => 'token'),
  inserts: [] as Array<Record<string, unknown>>,
  settingsRows: [] as Array<Record<string, unknown>>,
  zeroListings: [] as Array<{ ebay_item_id: string }>,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_settings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn(async () => ({ data: mocks.settingsRows, error: null })),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        }
      }
      if (table === 'inventory_runs') return { insert: vi.fn(async (row: Record<string, unknown>) => { mocks.inserts.push(row); return { error: null } }) }
      // 出品アカウント経由の接続なし(従来どおり単一トークンで動く)
      if (table === 'seller_accounts') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'not', 'order', 'update']) chain[m] = vi.fn(() => chain)
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        return chain
      }
      if (table === 'inventory_active_listings') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'not', 'is']) chain[m] = vi.fn(() => chain)
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: mocks.zeroListings, error: null })
        return chain
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  })),
}))
vi.mock('@/lib/inventory-supplier-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inventory-supplier-check')>()),
  checkSupplierListings: mocks.check,
}))
vi.mock('@/lib/ebay-actions', () => ({ reviseInventoryStatusBatch: mocks.revise }))
vi.mock('@/lib/inventory-sync', () => ({ markListingsDelisted: mocks.markDelisted }))
vi.mock('@/lib/inventory-auth', () => ({
  resolveInventoryAccessToken: mocks.resolveToken,
  resolveSellerAccountAccessToken: vi.fn(async () => 'token'),
}))

describe('GET /api/cron/flea-check', () => {
  const originalSecret = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = 's'
    mocks.inserts.length = 0
    mocks.zeroListings.length = 0
    mocks.settingsRows = [{ user_id: 'u1', ebay_token: 't', auto_delist: true, delist_on_sold_out: true, delist_by_age_enabled: false, days_until_delist: 29 }]
    mocks.check.mockReset()
    mocks.revise.mockReset().mockResolvedValue({ results: [{ itemId: '111', success: true }], deferred: 0 })
  })
  afterEach(() => { process.env.CRON_SECRET = originalSecret })

  const req = () => new NextRequest('http://localhost/api/cron/flea-check', { headers: { authorization: 'Bearer s' } })

  it('Yahoo!フリマの商品だけを12件確認し、売り切れがあればその場で在庫0にして履歴に残す', async () => {
    mocks.check.mockResolvedValue({ total: 12, available: 11, unavailable: 1, skipped: 0, failed: 0, price_recalculated: 0, title_changed: 0, rate_limited: 0, items: [] })
    mocks.zeroListings.push({ ebay_item_id: '111' })
    const { GET } = await import('@/app/api/cron/flea-check/route')
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(mocks.check).toHaveBeenCalledWith(expect.anything(), 'u1', 12, expect.objectContaining({ sourceSite: 'yahoo_flea' }))
    expect(mocks.revise).toHaveBeenCalledWith('token', [{ itemId: '111', quantity: 0, siteId: 'US' }])
    expect(mocks.inserts.map(r => r.run_type)).toEqual(['flea_check', 'auto_delist'])
  })

  it('変化が無い回は履歴を残さず、取り下げも行わない', async () => {
    mocks.check.mockResolvedValue({ total: 12, available: 12, unavailable: 0, skipped: 0, failed: 0, price_recalculated: 0, title_changed: 0, rate_limited: 0, items: [] })
    const { GET } = await import('@/app/api/cron/flea-check/route')
    await GET(req())
    expect(mocks.inserts).toHaveLength(0)
    expect(mocks.revise).not.toHaveBeenCalled()
  })

  it('認証キーが違えば401', async () => {
    const { GET } = await import('@/app/api/cron/flea-check/route')
    const res = await GET(new NextRequest('http://localhost/api/cron/flea-check', { headers: { authorization: 'Bearer x' } }))
    expect(res.status).toBe(401)
  })
})
