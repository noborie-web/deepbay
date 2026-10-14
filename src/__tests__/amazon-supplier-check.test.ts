import { beforeEach, describe, expect, it, vi } from 'vitest'

// ユーザー要望(2026-10-13): Amazonを仕入先にした無在庫では、Amazon側で
// 値上がり・在庫切れしたのに出品が残るのが一番危ない。HTMLではなくSP-APIで
// ASINをまとめて照会する。
const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  findScraper: vi.fn(() => null),
  fetchUsdJpyRate: vi.fn(),
  fetchAmazonSupplierStatus: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl, findScraper: mocks.findScraper }))
vi.mock('@/lib/exchange-rate', () => ({ fetchUsdJpyRate: mocks.fetchUsdJpyRate }))
vi.mock('@/lib/amazon-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/amazon-extract')>()
  return { ...actual, fetchAmazonSupplierStatus: mocks.fetchAmazonSupplierStatus }
})

import { checkSupplierListings } from '@/lib/inventory-supplier-check'

const ASIN = 'B0F18J2CJF'

function makeDatabase() {
  const updates: Array<Record<string, unknown>> = []
  const product = {
    id: 'p1',
    source_url: `https://www.amazon.co.jp/dp/${ASIN}`,
    source_site: 'amazon',
    original_title: 'Amazon商品',
    original_price: 5000,
    purchase_price_jpy: 5000,
    ebay_price: 60,
    pricing_jpy_per_usd: 150,
    extraction_id: null,
  }
  const db = {
    from(table: string) {
      const state = { update: null as Record<string, unknown> | null }
      const query = {
        select: () => query,
        eq: () => query,
        not: () => query,
        gt: () => query,
        or: () => query,
        is: () => query,
        in: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        update(payload: Record<string, unknown>) {
          state.update = payload
          if (table === 'inventory_active_listings') updates.push(payload)
          return query
        },
        then(resolve: (value: unknown) => unknown) {
          if (state.update) return Promise.resolve({ data: null, error: null }).then(resolve)
          if (table === 'inventory_active_listings') {
            return Promise.resolve({
              data: [{ id: 'l1', product_id: 'p1', ebay_item_id: '1', supplier_verified_at: new Date().toISOString() }],
              error: null,
            }).then(resolve)
          }
          if (table === 'products') return Promise.resolve({ data: [product], error: null }).then(resolve)
          return Promise.resolve({ data: [], error: null }).then(resolve)
        },
      }
      return query
    },
  }
  return { db, updates }
}

describe('Amazonの仕入先チェック', () => {
  beforeEach(() => {
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150 })
    mocks.scrapeUrl.mockReset()
    mocks.findScraper.mockReset().mockReturnValue(null)
    mocks.fetchAmazonSupplierStatus.mockReset()
  })

  it('HTMLを取りに行かず、SP-APIでASINを照会する', async () => {
    mocks.fetchAmazonSupplierStatus.mockResolvedValue(new Map([
      [ASIN, { available: true, priceJpy: 5000, isFba: true }],
    ]))

    const { db } = makeDatabase()
    const result = await checkSupplierListings(db as never, 'user-1', 10, {})

    expect(mocks.scrapeUrl).not.toHaveBeenCalled()
    expect(mocks.fetchAmazonSupplierStatus.mock.calls[0][2]).toEqual([ASIN])
    expect(result.available).toBe(1)
  })

  it('新品が買えなくなっていたら在庫0にする', async () => {
    mocks.fetchAmazonSupplierStatus.mockResolvedValue(new Map([
      [ASIN, { available: false, priceJpy: null, isFba: false }],
    ]))

    const { db, updates } = makeDatabase()
    const result = await checkSupplierListings(db as never, 'user-1', 10, {})

    expect(result.unavailable).toBe(1)
    expect(updates[0].quantity).toBe(0)
  })

  // 2026-09-22の事故(HTMLの429を売り切れと誤判定して64件を取り下げた)と同じ考え方
  it('照会できなかったASINは売り切れ扱いにしない', async () => {
    mocks.fetchAmazonSupplierStatus.mockResolvedValue(new Map())

    const { db, updates } = makeDatabase()
    const result = await checkSupplierListings(db as never, 'user-1', 10, {})

    expect(result.unavailable).toBe(0)
    expect(result.skipped + result.check_errors).toBeGreaterThan(0)
    expect(updates.some((update) => update.quantity === 0)).toBe(false)
  })

  it('認証切れ等で照会自体が失敗しても、売り切れ扱いにしない', async () => {
    mocks.fetchAmazonSupplierStatus.mockRejectedValue(new Error('Amazonの認証に失敗しました'))

    const { db, updates } = makeDatabase()
    const result = await checkSupplierListings(db as never, 'user-1', 10, {})

    expect(result.unavailable).toBe(0)
    expect(updates.some((update) => update.quantity === 0)).toBe(false)
  })

  it('値上がりした場合は、仕入先の最新価格として記録する', async () => {
    mocks.fetchAmazonSupplierStatus.mockResolvedValue(new Map([
      [ASIN, { available: true, priceJpy: 7000, isFba: true }],
    ]))

    const { db, updates } = makeDatabase()
    await checkSupplierListings(db as never, 'user-1', 10, {})

    expect(updates[0].supplier_price_jpy).toBe(7000)
  })

  it('カタログ名は取りに行かないので、タイトル変更の誤検知が起きない', async () => {
    mocks.fetchAmazonSupplierStatus.mockResolvedValue(new Map([
      [ASIN, { available: true, priceJpy: 5000, isFba: true }],
    ]))

    const { db } = makeDatabase()
    const result = await checkSupplierListings(db as never, 'user-1', 10, { delistOnTitleChange: true })

    expect(result.title_changed).toBe(0)
    expect(result.title_changed_delisted).toBe(0)
  })
})
