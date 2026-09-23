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

import { checkSupplierListings, detectSupplierDiff, isReservedTitle, normalizePriceChangeFilter, scalePriceByExchangeRate, shouldUpdateEbayPrice } from '@/lib/inventory-supplier-check'
import { calculateAutomaticEbayPrice } from '@/lib/extraction-run'

interface ProductFixture {
  id: string
  source_url: string | null
  source_site?: string | null
  original_title?: string | null
  original_price?: number | null
  purchase_price_jpy?: number | null
  ebay_price?: number | null
  pricing_jpy_per_usd?: number | null
  extraction_id?: string | null
}

function makeDatabase(options: {
  listings: Array<{ id: string; product_id: string; ebay_item_id?: string }>
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

// ユーザー要望(2026-09-23): 仕入先のタイトルが変わったら別商品に差し替えられた
// 可能性が高いので取り下げる。ただし空白・全角半角の違いは変更とみなさない。
describe('detectSupplierDiff のタイトル比較', () => {
  it('空白・全角半角の違いだけならタイトル変更とみなさない', async () => {
    const { detectSupplierDiff } = await import('@/lib/inventory-supplier-check')
    expect(detectSupplierDiff(
      { title: 'FC エイトアイズ ファミコン ソフトのみ 8Eyes レア', priceJpy: 6780 },
      { title: 'FC  エイトアイズ　ファミコン ソフトのみ  8Eyes レア', priceJpy: 6780 },
    )).toEqual([])
  })

  it('中身が変わっていればタイトル変更として検知する', async () => {
    const { detectSupplierDiff } = await import('@/lib/inventory-supplier-check')
    expect(detectSupplierDiff(
      { title: 'Cubic U 「 Precious 」宇多田ヒカル　新品シ', priceJpy: 49500 },
      { title: 'Cubic U / Precious', priceJpy: 400 },
    )).toEqual(['title', 'price'])
  })
})

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

  // 実データで確認した不具合: eBayから復元して仕入先URLが不明(仮のeBay URL)の
  // 商品は、毎朝のeBay同期で在庫数が1に戻り、仕入先チェックもskippedのため
  // 取り下げられなかった。仕入先がない商品は毎回「仕入不可」として在庫0にする。
  it('仕入先URLが不明(source_site=ebay)の商品は毎回在庫0にして取り下げ対象にする', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-ebay', product_id: 'product-ebay' }],
      products: [{ id: 'product-ebay', source_url: 'https://www.ebay.com/itm/123', source_site: 'ebay' }],
    })
    mocks.findScraper.mockReturnValue(null)

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result).toMatchObject({ total: 1, unavailable: 1, skipped: 0, no_supplier: 1 })
    expect(mocks.scrapeUrl).not.toHaveBeenCalled()
    expect(updateCalls(calls)[0].payload).toEqual(expect.objectContaining({ quantity: 0 }))
  })

  // 本番で確認した不具合(2026-09-22): Yahoo!フリマの429を「売り切れ」と誤判定し64件の
  // 在庫を0にした。404/410 だけを売り切れとし、429 は未確認(次回に回す)にする。
  it('429(アクセス過多)で取得できなかった商品は在庫0にせず、checked_atも更新しないで次回に回す', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-429', product_id: 'product-429', ebay_item_id: 'item-429' }],
      products: [{ id: 'product-429', source_url: 'https://paypayfleamarket.yahoo.co.jp/item/z1', source_site: 'yahoo_flea' }],
    })
    mocks.scrapeUrl.mockRejectedValueOnce(new Error('HTTP 429: Too Many Requests'))

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result).toMatchObject({ total: 1, unavailable: 0, skipped: 1, rate_limited: 1, check_errors: 1 })
    expect(updateCalls(calls)).toHaveLength(0)
  })

  it('ネットワークエラー等は在庫0にせず未確認として checked_at だけ更新する', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-err', product_id: 'product-err', ebay_item_id: 'item-err' }],
      products: [{ id: 'product-err', source_url: 'https://jp.mercari.com/item/m1' }],
    })
    mocks.scrapeUrl.mockRejectedValueOnce(new Error('fetch failed'))

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result).toMatchObject({ unavailable: 0, skipped: 1, check_errors: 1, rate_limited: 0 })
    expect(updateCalls(calls)[0].payload).not.toHaveProperty('quantity')
  })

  it('Yahoo!フリマの商品は1回の実行で12件までしか商品ページを確認しない', async () => {
    const listings = Array.from({ length: 15 }, (_, i) => ({ id: `l${i}`, product_id: `p${i}`, ebay_item_id: `item${i}` }))
    const products = listings.map(l => ({ id: l.product_id, source_url: `https://paypayfleamarket.yahoo.co.jp/item/z${l.id}`, source_site: 'yahoo_flea' }))
    const { db } = makeDatabase({ listings, products })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available' }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(mocks.scrapeUrl).toHaveBeenCalledTimes(12)
    expect(result).toMatchObject({ total: 15, available: 12, skipped: 3 })
  })

  it('sets quantity to zero when the supplier page returns 404 and continues with later rows', async () => {
    const { db, calls } = makeDatabase({
      listings: [
        { id: 'listing-404', product_id: 'product-404', ebay_item_id: 'item-404' },
        { id: 'listing-ok', product_id: 'product-ok', ebay_item_id: 'item-ok' },
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

    expect(result).toMatchObject({ total: 2, available: 1, unavailable: 1, skipped: 0, failed: 0, price_increased: 0, price_recalculated: 0, title_changed: 0, reserved: 0, no_supplier: 0 })
    expect(result.items.map(i => [i.ebay_item_id, i.outcome])).toEqual([["item-404", "unavailable"], ["item-ok", "available"]])
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

    expect(result).toMatchObject({ total: 2, available: 1, unavailable: 0, skipped: 0, failed: 1, price_increased: 0, price_recalculated: 0, title_changed: 0, reserved: 0, no_supplier: 0 })
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
  describe('段階利益設定(価格モデル)による追従', () => {
    const tierModel = {
      kind: 'tiered' as const,
      tiers: [
        { profitJpy: 2000, maxPurchaseJpy: 5000 },
        { profitJpy: 3000, maxPurchaseJpy: 10000 },
        { profitJpy: 5000, maxPurchaseJpy: 20000 },
        { profitJpy: 10000, maxPurchaseJpy: 50000 },
        { profitJpy: 15000, maxPurchaseJpy: null },
      ],
      ebayFeeRate: 0.15, shippingJpy: 6000, fixedCostUsd: 0, adRate: 0.04, customsRate: 0.13, discountRate: 0.05,
    }

    it('仕入価格が上がったら、ユーザーの段階利益設定の式で再計算して値上げする', async () => {
      // 本番で確認: PUNK HITS ¥25,800→¥35,800。一括編集設定の利益率方式では
      // 手動設定より低い価格になっていたため、ユーザーの式で計算する。
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1', source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 25800, ebay_price: 430.62, pricing_jpy_per_usd: 154.08,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 35800 }])
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 154.69, date: '2026-09-16' })

      const result = await checkSupplierListings(db as never, 'user-1', 500, { pricingModel: tierModel })

      expect(result.price_recalculated).toBe(1)
      expect(result.price_increased).toBe(1)
      const payload = updateCalls(calls, 'products')[0].payload!
      expect(payload.purchase_price_jpy).toBe(35800)
      // (35800 + 10000 + 6000) / 154.69 / 0.63
      expect(payload.ebay_price as number).toBeCloseTo(531.5, 0)
    })

    // 本番で確認した不具合(2026-09-22): 別プリセット(提案B)で付けた価格が、保存中の
    // 段階利益設定(提案A)の価格に書き換えられた(148.2 → 143.08)。出品時の利益額を
    // 維持して仕入価格・為替の変動分だけ動かす。
    it('段階利益と違う利益額で付けた価格は、為替が動いても利益額を維持したまま追従する(再ティア化しない)', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1', source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 5980, ebay_price: 148.2, pricing_jpy_per_usd: 156.84,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5980 }])
      // 為替が約4%動いたケース(1%の閾値を超えるので更新対象)
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 163, date: '2026-09-22' })

      const result = await checkSupplierListings(db as never, 'user-1', 500, { pricingModel: tierModel })

      expect(result.price_recalculated).toBe(1)
      const payload = updateCalls(calls, 'products')[0].payload!
      // 利益額維持: 148.2 × 156.84 / 163 ≒ 142.6(段階利益¥3,000で再計算した約$146や¥2,200の約$138ではない)
      expect(payload.ebay_price as number).toBeCloseTo(148.2 * 156.84 / 163, 0)
    })

    // 本番で確認した不具合(2026-09-22): numeric列が文字列で返り、出品時レート未記録
    // 扱いになって段階利益で再計算されていた。文字列でも利益額維持で追従する。
    it('DBのnumeric列が文字列で返っても、利益額維持で追従する', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1', source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: '48000' as unknown as number, ebay_price: '627.07' as unknown as number, pricing_jpy_per_usd: '156.84' as unknown as number,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 48000 }])
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 163, date: '2026-09-22' })

      await checkSupplierListings(db as never, 'user-1', 500, { pricingModel: tierModel })

      const payload = updateCalls(calls, 'products')[0].payload!
      // 利益額維持(627.07 × 156.84 / 163 ≒ 603.4)。段階利益¥10,000で再計算した約$623ではない
      expect(payload.ebay_price as number).toBeCloseTo(627.07 * 156.84 / 163, 0)
    })

    it('出品時レートが未記録でも、段階利益で再計算せず現在価格を維持する(為替変動なし扱い)', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1', source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 48000, ebay_price: 627.07, pricing_jpy_per_usd: null,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 48000 }])
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 157.33, date: '2026-09-22' })

      const result = await checkSupplierListings(db as never, 'user-1', 500, { pricingModel: tierModel })

      // 段階利益(¥10,000)で再計算した $645 にも、提案Aの $605 にもならず、価格は変えない
      expect(result.price_recalculated).toBe(0)
      const productUpdates = updateCalls(calls, 'products')
      // 基準レートだけ記録される
      expect(productUpdates[0]?.payload).toEqual({ pricing_jpy_per_usd: 157.33 })
    })

    // ユーザー要望「赤字になるのは絶対に避けて」: 仕入価格が下がっていないのに
    // 15%超の値下げになる再計算はロジック不具合とみなして適用しない(安全網)。
    it('仕入価格が下がっていないのに15%超の値下げになる場合は適用しない', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1', source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 48000, ebay_price: 627.07, pricing_jpy_per_usd: 156.84,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 48000 }])
      // 為替が20%以上円安に振れた極端なケース(価格は-17%程度になる)
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 190, date: '2026-09-22' })

      const result = await checkSupplierListings(db as never, 'user-1', 500, { pricingModel: tierModel })

      expect(result.price_recalculated).toBe(0)
      expect(result.guarded).toBe(1)
    })

    it('仕入価格も為替も変わっていなければ、同じ式なので差分が出ず更新しない', async () => {
      const { db, calls } = makeDatabase({
        listings: [{ id: 'listing-1', product_id: 'product-1' }],
        products: [{
          id: 'product-1', source_url: 'https://jp.mercari.com/item/1',
          purchase_price_jpy: 17888, ebay_price: 297.6, pricing_jpy_per_usd: 154.08,
        }],
      })
      mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 17888 }])
      mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 154.08, date: '2026-09-16' })

      const result = await checkSupplierListings(db as never, 'user-1', 500, { pricingModel: tierModel })

      expect(result.price_recalculated).toBe(0)
      expect(updateCalls(calls, 'products')).toHaveLength(0)
    })
  })

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

// ユーザー要望: メルカリでは購入者に取り置きするためタイトルを
// 「〇〇様専用」に変更する出品者がいる。在庫切れと同じ扱いにする。
describe('専用(取り置き)タイトルの検知', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
    mocks.findScraper.mockReset().mockReturnValue({ siteKey: 'mercari' })
    mocks.scrapeUrl.mockReset()
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-08-27' })
  })
  afterEach(() => { vi.useRealTimers() })

  it('タイトルが「〇〇様専用」になっていたら在庫0(売り切れと同じ)にする', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-1', product_id: 'product-1' }],
      products: [{
        id: 'product-1', source_url: 'https://jp.mercari.com/item/1',
        original_title: 'ATEEZ サン タワレコ特典 キャンパスボード', original_price: 8999,
        purchase_price_jpy: 8999, ebay_price: 185.43, pricing_jpy_per_usd: 150,
      }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', title: 'Risa様専用', price: 2222 }])

    const result = await checkSupplierListings(db as never, 'user-1')

    expect(result.unavailable).toBe(1)
    expect(result.reserved).toBe(1)
    expect(result.price_recalculated).toBe(0)
    expect(updateCalls(calls)[0].payload).toMatchObject({
      quantity: 0,
      supplier_title: 'Risa様専用',
      supplier_diff: ['title', 'reserved', 'price'],
    })
    // 取り置きの仮価格(¥2,222)でeBay価格を再計算してはいけない
    expect(updateCalls(calls, 'products')).toHaveLength(0)
  })

  it('isReservedTitle: 専用・取り置きの表記を検知し、通常のタイトルは検知しない', () => {
    expect(isReservedTitle('Risa様専用')).toBe(true)
    expect(isReservedTitle('Risa 様 専用')).toBe(true)
    expect(isReservedTitle('専用出品 ATEEZ トレカ')).toBe(true)
    expect(isReservedTitle('ATEEZ トレカ 専用')).toBe(true)
    expect(isReservedTitle('お取り置き中 ATEEZ トレカ')).toBe(true)
    expect(isReservedTitle('取置き ATEEZ トレカ')).toBe(true)
    expect(isReservedTitle('ATEEZ サン タワレコ特典 キャンパスボード')).toBe(false)
    expect(isReservedTitle('PS5専用コントローラー')).toBe(false)
    expect(isReservedTitle('iPhone専用ケース 新品')).toBe(false)
    expect(isReservedTitle(null)).toBe(false)
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


// ユーザー要望(2026-09-23): タイトルが変わったら取り下げ対象にする。
// 実データ: ¥49,500のCDが「Cubic U / Precious」¥400 に差し替えられ、eBay価格が-81%になった。
describe('タイトル変更での取り下げ', () => {
  it('delistOnTitleChange が有効なら、タイトルが変わった商品を在庫0にして価格を追従しない', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-1', product_id: 'product-1' }],
      products: [{
        id: 'product-1', source_url: 'https://jp.mercari.com/item/m1',
        original_title: 'Cubic U 「 Precious 」宇多田ヒカル　新品シ', original_price: 49500,
        purchase_price_jpy: 49500, ebay_price: 624.24, pricing_jpy_per_usd: 157.38,
      }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 400, title: 'Cubic U / Precious' }])
    mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 157.38, date: '2026-09-23' })

    const result = await checkSupplierListings(db as never, 'user-1', 500, { delistOnTitleChange: true })

    expect(result).toMatchObject({ unavailable: 1, title_changed_delisted: 1 })
    expect(updateCalls(calls)[0].payload).toEqual(expect.objectContaining({ quantity: 0 }))
    // 価格は追従しない(products は更新しない)
    expect(updateCalls(calls, 'products')).toHaveLength(0)
  })

  it('無効なら従来どおり差分の記録だけ行い、在庫は変えない', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-1', product_id: 'product-1' }],
      products: [{
        id: 'product-1', source_url: 'https://jp.mercari.com/item/m1',
        original_title: '旧タイトル', original_price: 5000,
        purchase_price_jpy: 5000, ebay_price: 135.14, pricing_jpy_per_usd: 156.84,
      }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 5000, title: '新タイトル' }])
    mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 156.84, date: '2026-09-23' })

    const result = await checkSupplierListings(db as never, 'user-1', 500, { delistOnTitleChange: false })

    expect(result).toMatchObject({ available: 1, unavailable: 0, title_changed: 1, title_changed_delisted: 0 })
    expect(updateCalls(calls)[0].payload).not.toHaveProperty('quantity')
  })

  it('仕入価格が30%超下がった場合は価格を追従しない(別商品・取得ミスの可能性)', async () => {
    const { db, calls } = makeDatabase({
      listings: [{ id: 'listing-1', product_id: 'product-1' }],
      products: [{
        id: 'product-1', source_url: 'https://jp.mercari.com/item/m1',
        original_title: '同じタイトル', original_price: 49500,
        purchase_price_jpy: 49500, ebay_price: 624.24, pricing_jpy_per_usd: 157.38,
      }],
    })
    mocks.scrapeUrl.mockResolvedValue([{ availability: 'available', price: 400, title: '同じタイトル' }])
    mocks.fetchUsdJpyRate.mockResolvedValue({ rate: 157.38, date: '2026-09-23' })

    const result = await checkSupplierListings(db as never, 'user-1', 500, { delistOnTitleChange: true })

    expect(result).toMatchObject({ guarded: 1, price_recalculated: 0 })
    expect(updateCalls(calls, 'products')).toHaveLength(0)
  })
})
