import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface QueryState {
  table: string
  operation: 'select' | 'update' | null
  payload?: Record<string, unknown>
  filters: Array<[string, unknown, unknown?]>
  limit?: number
  order?: { column: string; options: Record<string, unknown> }
}

const mocks = vi.hoisted(() => ({
  findScraper: vi.fn(),
  scrapeUrl: vi.fn(),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({
  findScraper: mocks.findScraper,
  scrapeUrl: mocks.scrapeUrl,
}))
vi.mock('@/lib/exchange-rate', () => ({ fetchUsdJpyRate: mocks.fetchUsdJpyRate }))

import { checkSupplierListings } from '@/lib/inventory-supplier-check'

interface ProductFixture {
  id: string
  source_url: string | null
  purchase_price_jpy?: number | null
  extraction_id?: string | null
}

function makeDatabase(options: {
  listings: Array<{ id: string; product_id: string }>
  products: Array<ProductFixture>
  extractions?: Array<{ id: string; bulk_edit_setting_id: string | null }>
  bulkEditSettings?: Array<{
    id: string
    profit_rate?: number | null
    ebay_fee_rate?: number | null
    shipping_cost_jpy?: number | null
    fixed_cost_usd?: number | null
  }>
  failingUpdateIds?: string[]
  failingProductUpdateIds?: string[]
}) {
  const calls: QueryState[] = []

  function resolveQuery(state: QueryState) {
    calls.push({
      ...state,
      payload: state.payload ? { ...state.payload } : undefined,
      filters: [...state.filters],
    })
    if (state.operation === 'update') {
      const idFilter = state.filters.find(([column]) => column === 'id')?.[1]
      const id = String(idFilter)
      if (state.table === 'inventory_active_listings') {
        return {
          data: null,
          error: options.failingUpdateIds?.includes(id) ? { message: 'update failed' } : null,
        }
      }
      if (state.table === 'products') {
        return {
          data: null,
          error: options.failingProductUpdateIds?.includes(id) ? { message: 'product update failed' } : null,
        }
      }
      return { data: null, error: null }
    }
    if (state.table === 'inventory_active_listings') {
      return { data: options.listings, error: null }
    }
    if (state.table === 'products') {
      return { data: options.products, error: null }
    }
    if (state.table === 'extractions') {
      return { data: options.extractions ?? [], error: null }
    }
    if (state.table === 'bulk_edit_settings') {
      return { data: options.bulkEditSettings ?? [], error: null }
    }
    throw new Error(`Unexpected query: ${state.table} ${state.operation}`)
  }

  const db = {
    from(table: string) {
      const state: QueryState = { table, operation: null, filters: [] }
      const finish = () => Promise.resolve(resolveQuery(state))
      const query = {
        select() { state.operation = state.operation ?? 'select'; return query },
        update(payload: Record<string, unknown>) { state.operation = 'update'; state.payload = payload; return query },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
        not(column: string, operator: string, value: unknown) { state.filters.push([column, operator, value]); return query },
        gt(column: string, value: unknown) { state.filters.push([column, 'gt', value]); return query },
        in(column: string, value: unknown) { state.filters.push([column, 'in', value]); return query },
        order(column: string, orderOptions: Record<string, unknown>) {
          state.order = { column, options: orderOptions }
          return query
        },
        limit(value: number) { state.limit = value; return query },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          return finish().then(onFulfilled, onRejected)
        },
      }
      return query
    },
  }

  return { db, calls }
}

function updateCalls(calls: QueryState[], table = 'inventory_active_listings') {
  return calls.filter(call => call.table === table && call.operation === 'update')
}

describe('checkSupplierListings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    mocks.findScraper.mockReset().mockReturnValue({ siteKey: 'mercari' })
    mocks.scrapeUrl.mockReset()
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-08-27' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets quantity to zero when the supplier page returns 404 and continues with later rows', async () => {
    const { db, calls } = makeDatabase({
      listings: [
        { id: 'listing-404', product_id: 'product-404' },
        { id: 'listing-ok', product_id: 'product-ok' },
      ],
      products: [
        { id: 'product-404', source_url: 'https://jp.mercari.com/item/deleted' },
        { id: 'product-ok', source_url: 'https://jp.mercari.com/item/available' },
      ],
    })
    mocks.scrapeUrl
      .mockRejectedValueOnce(new Error('Item page error: 404'))
      .mockResolvedValueOnce([{ availability: 'available' }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result).toEqual({ total: 2, available: 1, unavailable: 1, skipped: 0, failed: 0, price_increased: 0 })
    expect(updateCalls(calls)).toEqual([
      expect.objectContaining({ payload: { supplier_checked_at: '2026-08-27T00:00:00.000Z', quantity: 0 } }),
      expect.objectContaining({ payload: { supplier_checked_at: '2026-08-27T00:00:00.000Z' } }),
    ])
  })

  it('sets quantity to zero when the scraper reports sold out', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-sold', product_id: 'product-sold' }],
      products: [{ id: 'product-sold', source_url: 'https://jp.mercari.com/item/sold' }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'sold_out' }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result.unavailable).toBe(1)
    expect(updateCalls(calls)[0].payload).toEqual({
      supplier_checked_at: '2026-08-27T00:00:00.000Z',
      quantity: 0,
    })
  })

  it('keeps quantity unchanged when the supplier item is available', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-ok', product_id: 'product-ok' }],
      products: [{ id: 'product-ok', source_url: 'https://jp.mercari.com/item/available' }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available' }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result.available).toBe(1)
    expect(updateCalls(calls)[0].payload).toEqual({
      supplier_checked_at: '2026-08-27T00:00:00.000Z',
    })
  })

  it('updates the check time but skips unsupported supplier URLs', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-unsupported', product_id: 'product-unsupported' }],
      products: [{ id: 'product-unsupported', source_url: 'https://unsupported.example/item/1' }],
    })
    mocks.findScraper.mockReturnValue(null)

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result.skipped).toBe(1)
    expect(mocks.scrapeUrl).not.toHaveBeenCalled()
    expect(updateCalls(calls)[0].payload).toEqual({
      supplier_checked_at: '2026-08-27T00:00:00.000Z',
    })
  })

  it('queries only matched positive-quantity listings in oldest-check order with the batch limit', async () => {
    const { db, calls } = makeDatabase({ listings: [], products: [] })

    await checkSupplierListings(db as never, 'user-1', 25)

    const listingQuery = calls[0]
    expect(listingQuery.filters).toEqual(expect.arrayContaining([
      ['user_id', 'user-1'],
      ['product_id', 'is', null],
      ['quantity', 'gt', 0],
    ]))
    expect(listingQuery.order).toEqual({
      column: 'supplier_checked_at',
      options: { ascending: true, nullsFirst: true },
    })
    expect(listingQuery.limit).toBe(25)
  })

  it('continues after one database update fails', async () => {
    const { db, calls } = makeDatabase({
      listings: [
        { id: 'listing-fails', product_id: 'product-1' },
        { id: 'listing-succeeds', product_id: 'product-2' },
      ],
      products: [
        { id: 'product-1', source_url: 'https://jp.mercari.com/item/1' },
        { id: 'product-2', source_url: 'https://jp.mercari.com/item/2' },
      ],
      failingUpdateIds: ['listing-fails'],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available' }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result).toEqual({ total: 2, available: 1, unavailable: 0, skipped: 0, failed: 1, price_increased: 0 })
    expect(updateCalls(calls)).toHaveLength(2)
  })

  it('adds supplier_checked_at to inventory listings', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20260827_inventory_supplier_checked_at.sql'),
      'utf8',
    )
    expect(sql).toMatch(/ALTER TABLE inventory_active_listings[\s\S]*supplier_checked_at timestamptz/i)
  })

  // ユーザー要望: 「仕入れ価格の高騰に確実に対応できる在庫管理」。仕入れ元の
  // 現在価格が前回記録したpurchase_price_jpyより上がっていた場合、eBay出品
  // 価格(products.ebay_price)を自動的に再計算・更新する。実際にeBayへの
  // 反映は既存の「価格改定」自動実行(products.ebay_priceとeBay上の現在価格
  // の差分検知)が担うため、ここではDB更新のみを検証する。
  describe('仕入れ価格の高騰検知', () => {
    it('仕入れ元価格が上昇していたら、products.ebay_priceを再計算して更新する', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 3000,
          extraction_id: null,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.price_increased).toBe(1)
      const productUpdate = updateCalls(calls, 'products')[0]
      expect(productUpdate.payload?.purchase_price_jpy).toBe(5000)
      expect(typeof productUpdate.payload?.ebay_price).toBe('number')
      expect((productUpdate.payload?.ebay_price as number)).toBeGreaterThan(0)
    })

    it('仕入れ元価格が上昇していなければ、products側は更新しない', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 5000,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.price_increased).toBe(0)
      expect(updateCalls(calls, 'products')).toHaveLength(0)
    })

    it('抽出時の一括編集設定(利益率等)があれば、その設定を使って再計算する', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 3000,
          extraction_id: 'extraction-1',
        }],
        extractions: [{ id: 'extraction-1', bulk_edit_setting_id: 'bulk-1' }],
        bulkEditSettings: [{ id: 'bulk-1', profit_rate: 0.3, ebay_fee_rate: 0.13, shipping_cost_jpy: 1000, fixed_cost_usd: 1 }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.price_increased).toBe(1)
      const productUpdate = updateCalls(calls, 'products')[0]
      expect((productUpdate.payload?.ebay_price as number)).toBeGreaterThan(0)
    })

    it('為替レート取得に失敗しても、売り切れチェック自体は継続する', async () => {
      mocks.fetchUsdJpyRate.mockRejectedValue(new Error('rate fetch failed'))
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 3000,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.available).toBe(1)
      expect(result.price_increased).toBe(0)
      expect(updateCalls(calls, 'products')).toHaveLength(0)
    })

    it('products側の更新が失敗しても、売り切れチェックの結果はfailedにしない', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 3000,
        }],
        failingProductUpdateIds: ['product-1'],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.available).toBe(1)
      expect(result.failed).toBe(0)
      expect(result.price_increased).toBe(0)
      expect(updateCalls(calls, 'products')).toHaveLength(1)
    })
  })
})
