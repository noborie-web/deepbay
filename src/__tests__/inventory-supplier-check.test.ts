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

import { checkSupplierListings, detectSupplierDiff, normalizePriceChangeFilter, scalePriceByExchangeRate, shouldUpdateEbayPrice } from '@/lib/inventory-supplier-check'
import { calculateAutomaticEbayPrice } from '@/lib/extraction-run'

interface ProductFixture {
  id: string
  source_url: string | null
  original_title?: string | null
  original_price?: number | null
  purchase_price_jpy?: number | null
  ebay_price?: number | null
  pricing_jpy_per_usd?: number | null
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

    expect(result).toEqual({ total: 2, available: 1, unavailable: 1, skipped: 0, failed: 0, price_increased: 0, price_recalculated: 0, title_changed: 0 })
    expect(updateCalls(calls)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ supplier_checked_at: '2026-08-27T00:00:00.000Z', quantity: 0 }) }),
      expect.objectContaining({ payload: expect.objectContaining({ supplier_checked_at: '2026-08-27T00:00:00.000Z' }) }),
    ])
  })

  it('時間予算を超えたら残りの商品はチェックせず次回に回す', async () => {
    // ユーザー要望: 売り切れ即取り下げ・価格再計算は必須。1日50件固定では
    // 148件を一巡するのに3日かかるため、時間予算内で可能な限り処理する。
    const { db, calls } = makeDatabase({
      listings: [
        { id: 'listing-1', product_id: 'product-1' },
        { id: 'listing-2', product_id: 'product-2' },
      ],
      products: [
        { id: 'product-1', source_url: 'https://jp.mercari.com/item/1' },
        { id: 'product-2', source_url: 'https://jp.mercari.com/item/2' },
      ],
    })
    mocks.scrapeUrl.mockImplementation(async () => {
      vi.advanceTimersByTime(2_000)
      return [{ availability: 'available' }]
    })

    const result = await checkSupplierListings(db as never, 'user-1', 500, { timeBudgetMs: 1_000 })

    expect(result).toMatchObject({ total: 2, available: 1, skipped: 1 })
    expect(mocks.scrapeUrl).toHaveBeenCalledTimes(1)
    expect(updateCalls(calls)).toHaveLength(1)
  })

  it('sets quantity to zero when the scraper reports sold out', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-sold', product_id: 'product-sold' }],
      products: [{ id: 'product-sold', source_url: 'https://jp.mercari.com/item/sold' }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'sold_out' }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result.unavailable).toBe(1)
    expect(updateCalls(calls)[0].payload).toMatchObject({
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
    expect(updateCalls(calls)[0].payload).toMatchObject({
      supplier_checked_at: '2026-08-27T00:00:00.000Z',
    })
    expect(updateCalls(calls)[0].payload).not.toHaveProperty('quantity')
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

    expect(result).toEqual({ total: 2, available: 1, unavailable: 0, skipped: 0, failed: 1, price_increased: 0, price_recalculated: 0, title_changed: 0 })
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

    it('仕入れ元価格も為替も変わっていなければ、products側は更新しない', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 5000,
          // 出品時点と同じ為替(150円)で計算した価格と、そのレートが登録済み
          ebay_price: calculateAutomaticEbayPrice(5000, 150, null),
          pricing_jpy_per_usd: 150,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.price_increased).toBe(0)
      expect(result.price_recalculated).toBe(0)
      expect(updateCalls(calls, 'products')).toHaveLength(0)
    })

    it('出品時レートが未記録なら、価格は変えずに今回のレートを基準として記録する(既存商品の初回チェック)', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 5000,
          // 価格一括編集で手動設定した価格(計算式とは一致しない)
          ebay_price: 123.45,
          pricing_jpy_per_usd: null,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.price_recalculated).toBe(0)
      const productUpdates = updateCalls(calls, 'products')
      expect(productUpdates).toHaveLength(1)
      expect(productUpdates[0].payload).toEqual({ pricing_jpy_per_usd: 150 })
    })

    // ユーザー要望: 「出品した時点の為替の変動の差も検知して再計算して
    // 価格に反映する」。仕入価格が同じでも為替が動いていれば再計算する。
    it('仕入れ元価格が同じでも為替が変動していれば、出品時レートとの比率で既存価格をスケールして更新する', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 5000,
          // 手動調整済みの価格でも、その調整を維持したまま為替分だけ動く
          ebay_price: 100,
          pricing_jpy_per_usd: 150,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])
      // 円高(150円→135円)になった
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 135, date: '2026-08-27' })

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.price_recalculated).toBe(1)
      expect(result.price_increased).toBe(0)
      const productUpdate = updateCalls(calls, 'products')[0]
      expect(productUpdate.payload).toEqual({
        purchase_price_jpy: 5000,
        ebay_price: 111.11,
        pricing_jpy_per_usd: 135,
      })
    })

    it('差分検知タイプが「プラスのみ」なら、円安による値下がりは反映しない', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 5000,
          ebay_price: 100,
          pricing_jpy_per_usd: 150,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000 }])
      // 円安(150円→165円) → 価格は下がる方向
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 165, date: '2026-08-27' })

      const result = await checkSupplierListings(db as never, 'user-1', 500, {
        priceChangeFilter: { direction: 'up', thresholdRate: 1 },
      })

      expect(result.price_recalculated).toBe(0)
      expect(updateCalls(calls, 'products')).toHaveLength(0)
    })

    it('仕入価格が未記録でもeBay価格は変えず、今回の仕入価格と為替を基準として記録する', async () => {
      // 本番で確認した不具合: 148件すべて purchase_price_jpy が未記録だったため
      // 「仕入価格が変わった」と誤判定し、計算式で再計算した約20%低い価格で
      // 価格一括編集済みのeBay価格を上書きしてしまった。
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: null,
          ebay_price: 297.6,
          pricing_jpy_per_usd: null,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 17888 }])

      const result = await checkSupplierListings(db as never, 'user-1')

      expect(result.price_recalculated).toBe(0)
      const productUpdates = updateCalls(calls, 'products')
      expect(productUpdates).toHaveLength(1)
      expect(productUpdates[0].payload).toEqual({ pricing_jpy_per_usd: 150, purchase_price_jpy: 17888 })
    })

    it('仕入価格が取得できない場合は前回記録した仕入価格と現在の為替で再計算する', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1',
          source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 5000,
          ebay_price: calculateAutomaticEbayPrice(5000, 150, null),
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available' }])
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 160, date: '2026-08-27' })

      const result = await checkSupplierListings(db as never, 'user-1')

      // 出品時レート未記録・仕入価格同じ → 基準レートの記録のみ
      expect(result.price_recalculated).toBe(0)
      expect(updateCalls(calls, 'products')[0].payload).toEqual({ pricing_jpy_per_usd: 160 })
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

// ユーザー要望: 「公式ツールはタイトルの差分も検知しています」
describe('仕入先のタイトル・価格の差分検知', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    mocks.findScraper.mockReset().mockReturnValue({ siteKey: 'mercari' })
    mocks.scrapeUrl.mockReset()
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-08-27' })
  })
  afterEach(() => { vi.useRealTimers() })

  it('仕入先の最新タイトルが抽出時から変わっていたら、差分として出品に記録する', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-1', product_id: 'product-1' }],
      products: [{
        id: 'product-1',
        source_url: 'https://jp.mercari.com/item/1',
        original_title: '【美品】ディズニー ピンバッジ',
        original_price: 8500,
        purchase_price_jpy: 8500,
        ebay_price: 100,
        pricing_jpy_per_usd: 150,
      }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', title: '【値下げ】ディズニー ピンバッジ', price: 8500 }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result.title_changed).toBe(1)
    expect(updateCalls(calls)[0].payload).toMatchObject({
      supplier_title: '【値下げ】ディズニー ピンバッジ',
      supplier_price_jpy: 8500,
      supplier_diff: ['title'],
      supplier_diff_detected_at: '2026-08-27T00:00:00.000Z',
    })
  })

  it('仕入先の価格が抽出時から変わっていたら price の差分として記録し、変わっていなければ差分なし', async () => {
    const { db, calls } = makeDatabase({
      listings: [
        { id: 'listing-1', product_id: 'product-1' },
        { id: 'listing-2', product_id: 'product-2' },
      ],
      products: [
        { id: 'product-1', source_url: 'https://jp.mercari.com/item/1', original_title: 'A', original_price: 8500, purchase_price_jpy: 8500, ebay_price: 100, pricing_jpy_per_usd: 150 },
        { id: 'product-2', source_url: 'https://jp.mercari.com/item/2', original_title: 'B', original_price: 6200, purchase_price_jpy: 6200, ebay_price: 80, pricing_jpy_per_usd: 150 },
      ],
    })
    mocks.scrapeUrl
      .mockResolvedValueOnce([{ availability: 'available', title: 'A', price: 7500 }])
      .mockResolvedValueOnce([{ availability: 'available', title: 'B', price: 6200 }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result.title_changed).toBe(0)
    const [first, second] = updateCalls(calls)
    expect(first.payload).toMatchObject({ supplier_price_jpy: 7500, supplier_diff: ['price'] })
    expect(second.payload).toMatchObject({ supplier_diff: [], supplier_diff_detected_at: null })
  })
})

describe('detectSupplierDiff', () => {
  it('タイトルと価格(円)の差分を判定する', () => {
    expect(detectSupplierDiff({ title: 'A', priceJpy: 1000 }, { title: 'A', priceJpy: 1000 })).toEqual([])
    expect(detectSupplierDiff({ title: 'A', priceJpy: 1000 }, { title: 'B', priceJpy: 1000 })).toEqual(['title'])
    expect(detectSupplierDiff({ title: 'A', priceJpy: 1000 }, { title: 'A', priceJpy: 900 })).toEqual(['price'])
    expect(detectSupplierDiff({ title: 'A', priceJpy: 1000 }, { title: 'B', priceJpy: 900 })).toEqual(['title', 'price'])
  })

  it('最新タイトル・価格が取得できない場合は差分としない', () => {
    expect(detectSupplierDiff({ title: 'A', priceJpy: 1000 }, { title: null, priceJpy: null })).toEqual([])
    expect(detectSupplierDiff({ title: null, priceJpy: null }, { title: 'B', priceJpy: 900 })).toEqual([])
  })
})

describe('shouldUpdateEbayPrice', () => {
  it('現在価格が未設定なら更新する', () => {
    expect(shouldUpdateEbayPrice(null, 100)).toBe(true)
    expect(shouldUpdateEbayPrice(undefined, 100)).toBe(true)
  })

  it('検知差分率(既定1%)以上の変動のときだけ更新する(為替の微小な揺れで毎日改定しない)', () => {
    expect(shouldUpdateEbayPrice(200, 201.5)).toBe(false)
    expect(shouldUpdateEbayPrice(200, 202)).toBe(true)
    expect(shouldUpdateEbayPrice(200, 197.5)).toBe(true)
    expect(shouldUpdateEbayPrice(200, 200)).toBe(false)
  })

  it('差分検知タイプで方向を絞り込める(公式ツールの絞り込み設定相当)', () => {
    // 現在$100 → $110(+10%)は検知、$90(−10%)と$105(+5%)は検知しない(率10%・プラスのみ)
    const up10 = { direction: 'up' as const, thresholdRate: 10 }
    expect(shouldUpdateEbayPrice(100, 110, up10)).toBe(true)
    expect(shouldUpdateEbayPrice(100, 90, up10)).toBe(false)
    expect(shouldUpdateEbayPrice(100, 105, up10)).toBe(false)
    const down5 = { direction: 'down' as const, thresholdRate: 5 }
    expect(shouldUpdateEbayPrice(100, 94, down5)).toBe(true)
    expect(shouldUpdateEbayPrice(100, 110, down5)).toBe(false)
  })
})

describe('scalePriceByExchangeRate', () => {
  it('出品時レート/現在レートの比率で価格を動かし、セント単位に丸める', () => {
    expect(scalePriceByExchangeRate(100, 150, 135)).toBe(111.11)
    expect(scalePriceByExchangeRate(100, 150, 165)).toBe(90.91)
    expect(scalePriceByExchangeRate(100, 150, 150)).toBe(100)
  })
})

describe('normalizePriceChangeFilter', () => {
  it('不正・未設定の値は既定(指定なし・1%)にする', () => {
    expect(normalizePriceChangeFilter(null)).toEqual({ direction: 'any', thresholdRate: 1 })
    expect(normalizePriceChangeFilter({ price_change_direction: 'sideways', price_change_threshold_rate: -3 }))
      .toEqual({ direction: 'any', thresholdRate: 1 })
    expect(normalizePriceChangeFilter({ price_change_direction: 'up', price_change_threshold_rate: '10' }))
      .toEqual({ direction: 'up', thresholdRate: 10 })
  })
})
