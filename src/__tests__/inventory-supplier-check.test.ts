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
}))

vi.mock('@/lib/scrapers', () => ({
  findScraper: mocks.findScraper,
  scrapeUrl: mocks.scrapeUrl,
}))

import { checkSupplierListings } from '@/lib/inventory-supplier-check'

function makeDatabase(options: {
  listings: Array<{ id: string; product_id: string }>
  products: Array<{ id: string; source_url: string | null }>
  failingUpdateIds?: string[]
}) {
  const calls: QueryState[] = []

  function resolveQuery(state: QueryState) {
    calls.push({
      ...state,
      payload: state.payload ? { ...state.payload } : undefined,
      filters: [...state.filters],
    })
    if (state.operation === 'update') {
      const listingId = String(state.filters.find(([column]) => column === 'id')?.[1])
      return {
        data: null,
        error: options.failingUpdateIds?.includes(listingId) ? { message: 'update failed' } : null,
      }
    }
    if (state.table === 'inventory_active_listings') {
      return { data: options.listings, error: null }
    }
    if (state.table === 'products') {
      return { data: options.products, error: null }
    }
    throw new Error(`Unexpected query: ${state.table} ${state.operation}`)
  }

  const db = {
    from(table: string) {
      const state: QueryState = { table, operation: null, filters: [] }
      const finish = () => Promise.resolve(resolveQuery(state))
      const query = {
        select() { state.operation = 'select'; return query },
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

function updateCalls(calls: QueryState[]) {
  return calls.filter(call => call.table === 'inventory_active_listings' && call.operation === 'update')
}

describe('checkSupplierListings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    mocks.findScraper.mockReset().mockReturnValue({ siteKey: 'mercari' })
    mocks.scrapeUrl.mockReset()
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

    expect(result).toEqual({ total: 2, available: 1, unavailable: 1, skipped: 0, failed: 0 })
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

    expect(result).toEqual({ total: 2, available: 1, unavailable: 0, skipped: 0, failed: 1 })
    expect(updateCalls(calls)).toHaveLength(2)
  })

  it('adds supplier_checked_at to inventory listings', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20260827_inventory_supplier_checked_at.sql'),
      'utf8',
    )
    expect(sql).toMatch(/ALTER TABLE inventory_active_listings[\s\S]*supplier_checked_at timestamptz/i)
  })
})
