import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mockResolveAccessToken = vi.fn()
const mockResolveSellerAccountToken = vi.fn()
const mockSyncInventoryListings = vi.fn()
const mockCheckSupplierListings = vi.fn()
const mockRunInsert = vi.fn()
const mockListingQueryCalls: Array<[string, ...unknown[]]> = []
let mockSettings: Array<Record<string, unknown>> = []
// 在庫管理の対象セラー(出品アカウント)。既定は「出品アカウント経由の接続なし」
// = 従来どおり単一トークンで動かすケース。
let mockSellerAccounts: Array<Record<string, unknown>> = []
const mockSellerAccountUpdates: Array<Record<string, unknown>> = []
// セラーごとの出品件数(同期の予算配分に使われる)
let mockSellerListingCounts: number[] = []

// inventory_active_listings への問い合わせチェーンを記録するモック。
// 自動取り下げが「Kakehashi商品に紐付く出品だけ」を対象にしているか検証する。
function listingQueryMock() {
  const chain: Record<string, unknown> = {}
  // 件数照会(select(_, {count:'exact', head:true}))のときは、セラーごとの
  // 出品件数を順に返す(同期の予算配分の検証用)。
  let counting = false
  for (const method of ['select', 'eq', 'not', 'lte', 'is']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      mockListingQueryCalls.push([method, ...args])
      if (method === 'select' && (args[1] as { head?: boolean } | undefined)?.head) counting = true
      return chain
    })
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(
    counting
      ? { data: null, error: null, count: mockSellerListingCounts.shift() ?? 0 }
      : { data: [], error: null },
  )
  return chain
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_settings') {
        // .select().eq(...) と .update(...).eq(...) の両方に対応
        const chain: Record<string, unknown> = {}
        chain.select = vi.fn(() => chain)
        chain.update = vi.fn(() => chain)
        chain.eq = vi.fn(() => chain)
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: mockSettings, error: null })
        return chain
      }
      if (table === 'inventory_runs') {
        // 二重起動防止の「直近の同期があるか」の照会は、無し(null)を返す
        const recent = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn(async () => ({ data: null, error: null })) }
        return { ...recent, insert: mockRunInsert.mockImplementation(async () => ({ error: null })) }
      }
      if (table === 'seller_accounts') {
        const chain: Record<string, unknown> = {}
        chain.select = vi.fn(() => chain)
        chain.update = vi.fn((values: Record<string, unknown>) => { mockSellerAccountUpdates.push(values); return chain })
        chain.eq = vi.fn(() => chain)
        chain.not = vi.fn(() => chain)
        chain.order = vi.fn(() => chain)
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: mockSellerAccounts, error: null })
        return chain
      }
      if (table === 'inventory_active_listings') return listingQueryMock()
      throw new Error(`Unexpected table: ${table}`)
    }),
  })),
}))

vi.mock('@/lib/inventory-sync', () => ({
  syncKnownInventoryListings: mockSyncInventoryListings,
  markListingsDelisted: vi.fn(async () => {}),
  applyRevisedPrices: vi.fn(async () => {}),
}))

vi.mock('@/lib/inventory-supplier-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inventory-supplier-check')>()),
  checkSupplierListings: mockCheckSupplierListings,
}))

vi.mock('@/lib/ebay-actions', () => ({
  endItem: vi.fn(),
  reviseInventoryStatusBatch: vi.fn(async () => ({ results: [], deferred: 0 })),
  addFixedPriceItem: vi.fn(),
}))

vi.mock('@/lib/inventory-auth', () => ({
  resolveInventoryAccessToken: mockResolveAccessToken,
  resolveSellerAccountAccessToken: mockResolveSellerAccountToken,
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
    mockResolveSellerAccountToken.mockReset().mockImplementation(async (_db: unknown, _userId: string, id: string) => `token-${id}`)
    mockSellerAccounts = []
    mockSellerAccountUpdates.length = 0
    mockSellerListingCounts = []
    mockSyncInventoryListings.mockReset().mockResolvedValue({ total: 12, matched: 8, ended: 0, discovered: 0, processed: 12, nextCursorItemId: null })
    mockCheckSupplierListings.mockReset().mockResolvedValue({
      total: 2,
      available: 1,
      unavailable: 1,
      skipped: 0,
      failed: 0,
    })
    mockRunInsert.mockClear()
    mockListingQueryCalls.length = 0
  })

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret
  })

  it('processes enabled users whenever the daily Vercel cron invokes the route', async () => {
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: 1 })
    expect(mockResolveAccessToken).toHaveBeenCalledOnce()
    // active出品が数十ページあるため、cronでは取得タイムアウトを引き上げて渡す
    expect(mockSyncInventoryListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 'access-token', { fetchTotalTimeoutMs: 110_000, discoveryTimeBudgetMs: 30_000, getItemConcurrency: 8, maxItemsPerRun: 800, cursorItemId: null, sellerAccountId: null, ownsUnassignedProducts: true })
    expect(mockCheckSupplierListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 500, { timeBudgetMs: 80_000, priceChangeFilter: { direction: 'any', thresholdRate: 1 }, delistOnTitleChange: true })
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
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.results[0].sync).toEqual({ error: 'sync failed' })
    expect(mockCheckSupplierListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 500, { timeBudgetMs: 80_000, priceChangeFilter: { direction: 'any', thresholdRate: 1 }, delistOnTitleChange: true })
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
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, processed: 2 })
    expect(json.results[0].auth).toEqual({ error: 'refresh failed' })
    expect(mockSyncInventoryListings).toHaveBeenCalledTimes(1)
    expect(mockSyncInventoryListings).toHaveBeenCalledWith(expect.anything(), 'user-2', 'access-token-2', { fetchTotalTimeoutMs: 110_000, discoveryTimeBudgetMs: 30_000, getItemConcurrency: 8, maxItemsPerRun: 800, cursorItemId: null, sellerAccountId: null, ownsUnassignedProducts: true })
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
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)
    const json = await res.json()

    expect(json).toMatchObject({ ok: true, processed: 1 })
    expect(mockResolveAccessToken).not.toHaveBeenCalled()
    expect(mockCheckSupplierListings).toHaveBeenCalledWith(expect.anything(), 'user-1', 500, { timeBudgetMs: 80_000, priceChangeFilter: { direction: 'any', thresholdRate: 1 }, delistOnTitleChange: true })
  })

  it('自動取り下げはKakehashi商品に紐付く出品だけを対象にする(他ツールの出品を取り下げない)', async () => {
    // ユーザー要望: eBayアカウント上には他ツールで在庫管理中の出品が
    // 約5,000件あり、Kakehashiの自動取り下げがそれらをEndしてはならない。
    mockSettings[0].auto_delist = true
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(mockListingQueryCalls).toContainEqual(['not', 'product_id', 'is', null])
    expect(mockListingQueryCalls).toContainEqual(['eq', 'quantity', 0])
  })

  it('N日経過取り下げがOFFなら自動取り下げを実行しない', async () => {
    // ユーザー要望: OFFの間は経過日数による取り下げを中止する
    // (自動取り下げトグルがONでも取り下げ対象を問い合わせない)。
    mockSettings[0].auto_delist = true
    mockSettings[0].delist_by_age_enabled = false
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(mockListingQueryCalls).not.toContainEqual(['eq', 'quantity', 0])
    expect(mockRunInsert).not.toHaveBeenCalledWith(expect.objectContaining({ run_type: 'auto_delist' }))
  })

  it('売り切れ即取り下げがONなら経過日数で絞らず、取り下げ済みを除いて自動取り下げする', async () => {
    // ユーザー要望: 「仕入先が売り切れたら即取り下げ(N日経過を待たない)」
    mockSettings[0].auto_delist = true
    mockSettings[0].delist_by_age_enabled = false
    mockSettings[0].delist_on_sold_out = true
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    })
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(mockListingQueryCalls).toContainEqual(['eq', 'quantity', 0])
    expect(mockListingQueryCalls).toContainEqual(['is', 'delisted_at', null])
    expect(mockListingQueryCalls.some(call => call[0] === 'lte' && call[1] === 'start_time')).toBe(false)
    expect(mockRunInsert).toHaveBeenCalledWith(expect.objectContaining({ run_type: 'auto_delist' }))
  })

  it('is configured for one daily invocation at midnight UTC', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))

    expect(config.crons).toContainEqual({
      path: '/api/cron/inventory-auto',
      schedule: '0 0 * * *',
    })
  })

  // ユーザー要望: 1日最大4回(03/09/15/21 JST)。稼働回数に含まれない時間帯は
  // 処理せず、価格改定は「朝のみ」設定なら朝以外の時間帯では行わない。
  describe('1日複数回の稼働', () => {
    it('稼働回数1回のユーザーは、朝以外の時間帯(slot=21)では処理しない', async () => {
      const { GET } = await import('@/app/api/cron/inventory-auto/route')
      mockSettings = [{ ...mockSettings[0], daily_run_count: 1 }]
      const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=21', { headers: { authorization: 'Bearer cron-secret' } })
      const res = await GET(req)
      const json = await res.json()
      expect(res.status).toBe(200)
      expect(json.results[0]).toMatchObject({ slot: 21, skipped: 'slot_inactive' })
      expect(mockSyncInventoryListings).not.toHaveBeenCalled()
    })

    it('稼働回数2回のユーザーは slot=21 でも処理し、価格改定が「朝のみ」なら価格改定だけ行わない', async () => {
      const { GET } = await import('@/app/api/cron/inventory-auto/route')
      mockSettings = [{ ...mockSettings[0], daily_run_count: 2, auto_revise_price: true, revise_price_schedule: 'morning' }]
      const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=21', { headers: { authorization: 'Bearer cron-secret' } })
      const res = await GET(req)
      const json = await res.json()
      expect(res.status).toBe(200)
      expect(mockSyncInventoryListings).toHaveBeenCalledOnce()
      expect(mockCheckSupplierListings).toHaveBeenCalledOnce()
      expect(json.results[0].revise_price).toBeUndefined()
      expect(mockRunInsert.mock.calls.some(c => c[0].run_type === 'auto_revise_price')).toBe(false)
    })

    it('価格改定が「毎回」なら slot=21 でも価格改定を行う', async () => {
      const { GET } = await import('@/app/api/cron/inventory-auto/route')
      mockSettings = [{ ...mockSettings[0], daily_run_count: 2, auto_revise_price: true, revise_price_schedule: 'every' }]
      const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=21', { headers: { authorization: 'Bearer cron-secret' } })
      await GET(req)
      expect(mockRunInsert.mock.calls.some(c => c[0].run_type === 'auto_revise_price')).toBe(true)
    })
  })

  // ユーザー要望: 「全体在庫管理を今すぐ実行」。user_id で対象を絞り、force=1 なら
  // 時間帯・二重起動の判定を行わない。
  it('force=1 なら稼働回数の時間帯に関わらず、指定ユーザーだけを処理する', async () => {
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    mockSettings = [{ ...mockSettings[0], daily_run_count: 1 }]
    const req = new NextRequest('http://localhost/api/cron/inventory-auto?slot=21&force=1&user_id=user-1', { headers: { authorization: 'Bearer cron-secret' } })
    const res = await GET(req)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.results[0].skipped).toBeUndefined()
    expect(mockSyncInventoryListings).toHaveBeenCalledOnce()
  })

  // ユーザー要望(2026-09-25): 出品アカウントを複数運用し、アカウントごとに
  // 独立して在庫管理する(混在させない)。
  it('出品アカウントが複数あるときは、セラーごとに別トークン・別カーソルで同期する', async () => {
    mockSellerAccounts = [
      { id: 'seller-a', seller_id: 'miyabi-24', display_name: null, ebay_marketplace_id: 'EBAY_US', inventory_enabled: true, ebay_connected_at: '2026-07-26T00:00:00Z', inventory_discovery_scanned_until: null, inventory_sync_cursor_item_id: 'item-100' },
      { id: 'seller-b', seller_id: 'akebono-32', display_name: null, ebay_marketplace_id: 'EBAY_AU', inventory_enabled: true, ebay_connected_at: '2026-09-25T00:00:00Z', inventory_discovery_scanned_until: null, inventory_sync_cursor_item_id: null },
    ]
    // miyabi-24 は695件、akebono-32 はまだ0件
    mockSellerListingCounts = [695, 0]
    const { GET } = await import('@/app/api/cron/inventory-auto/route')
    const res = await GET(new NextRequest('http://localhost/api/cron/inventory-auto?slot=9', {
      headers: { authorization: 'Bearer cron-secret' },
    }))

    expect(res.status).toBe(200)
    expect(mockSyncInventoryListings).toHaveBeenCalledTimes(2)
    // セラーAは自分のトークン・自分のカーソル・自分のseller_account_idで同期する
    expect(mockSyncInventoryListings).toHaveBeenNthCalledWith(1, expect.anything(), 'user-1', 'token-seller-a', expect.objectContaining({
      sellerAccountId: 'seller-a', cursorItemId: 'item-100', ownsUnassignedProducts: true,
    }))
    expect(mockSyncInventoryListings).toHaveBeenNthCalledWith(2, expect.anything(), 'user-1', 'token-seller-b', expect.objectContaining({
      sellerAccountId: 'seller-b', cursorItemId: null, ownsUnassignedProducts: false,
    }))
    // 実行時間は出品件数の比率で分ける(出品0件のセラーには最低限だけ)
    const firstOptions = mockSyncInventoryListings.mock.calls[0][3] as { fetchTotalTimeoutMs: number; maxItemsPerRun: number }
    const secondOptions = mockSyncInventoryListings.mock.calls[1][3] as { fetchTotalTimeoutMs: number; maxItemsPerRun: number }
    expect(firstOptions).toMatchObject({ fetchTotalTimeoutMs: 110_000, maxItemsPerRun: 800 })
    expect(secondOptions).toMatchObject({ fetchTotalTimeoutMs: 15_000, maxItemsPerRun: 50 })
    // 従来の単一トークンには一度もフォールバックしない
    expect(mockResolveAccessToken).not.toHaveBeenCalled()
    // カーソルはセラーごとに記録する
    expect(mockSellerAccountUpdates).toEqual([
      { inventory_sync_cursor_item_id: null },
      { inventory_sync_cursor_item_id: null },
    ])
  })
})
