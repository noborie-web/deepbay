import { beforeEach, describe, expect, it, vi } from 'vitest'
import { calcProfit, DEFAULT_AUTO_PRICING } from '@/lib/pricing'

const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  translateTitles: vi.fn(),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl }))
vi.mock('@/lib/translate', () => ({ translateTitles: mocks.translateTitles }))
vi.mock('@/lib/exchange-rate', () => ({ fetchUsdJpyRate: mocks.fetchUsdJpyRate }))

import { calculateAutomaticEbayPrice, runScrape } from '@/lib/extraction-run'

const scrapedProduct = {
  sourceUrl: 'https://example.com/item/1',
  sourceSite: 'mercari',
  sourceItemId: 'item-1',
  title: 'テスト商品',
  price: 5000,
  description: '説明',
  images: ['https://example.com/image.jpg'],
  condition: '中古',
  sellerRatingCount: 10,
  shippingDays: 2,
  sourceUpdatedAt: null,
}

function makeDatabase(setting: Record<string, unknown> | null = null) {
  const insertedProducts: Array<Record<string, unknown>> = []
  const extractionUpdates: Array<Record<string, unknown>> = []

  function resultFor(table: string) {
    if (table === 'danger_sellers' || table === 'danger_words' || table === 'replace_words') {
      return { data: [], error: null }
    }
    if (table === 'extraction_settings') {
      return {
        data: {
          title_enabled: false,
          exclude_active_duplicate: false,
          exclude_title_duplicate: false,
          exclude_translated_duplicate: false,
          html_template_id: null,
        },
        error: null,
      }
    }
    if (table === 'bulk_edit_settings') return { data: setting, error: null }
    return { data: null, error: null }
  }

  const db = {
    from(table: string) {
      let updatePayload: Record<string, unknown> | null = null
      const query = {
        select() { return query },
        eq() { return query },
        single() { return Promise.resolve(resultFor(table)) },
        update(payload: Record<string, unknown>) {
          updatePayload = payload
          if (table === 'extractions') extractionUpdates.push(payload)
          return query
        },
        insert(payload: Array<Record<string, unknown>>) {
          if (table === 'products') insertedProducts.push(...payload)
          return Promise.resolve({ data: null, error: null })
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          const value = updatePayload ? { data: null, error: null } : resultFor(table)
          return Promise.resolve(value).then(onFulfilled, onRejected)
        },
      }
      return query
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }
  return { db, insertedProducts, extractionUpdates }
}

describe('automatic extraction pricing', () => {
  beforeEach(() => {
    mocks.scrapeUrl.mockReset().mockResolvedValue([
      scrapedProduct,
      { ...scrapedProduct, sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2' },
    ])
    mocks.translateTitles.mockReset()
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-08-25' })
  })

  it('uses the same calcProfit result with defaults when no bulk setting is selected', async () => {
    const { db, insertedProducts } = makeDatabase()
    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const expected = calcProfit({
      purchasePriceJpy: 5000,
      jpyPerUsd: 150,
      ebayFeeRate: DEFAULT_AUTO_PRICING.ebayFeeRate,
      targetProfitRate: DEFAULT_AUTO_PRICING.profitRate,
      shippingUsd: DEFAULT_AUTO_PRICING.shippingCostJpy / 150,
      fixedCostUsd: DEFAULT_AUTO_PRICING.fixedCostUsd,
    }).salePriceUsd
    expect(result).toEqual({ status: 'completed' })
    expect(insertedProducts[0].ebay_price).toBe(expected)
    expect(insertedProducts[1].ebay_price).toBe(expected)
    expect(calculateAutomaticEbayPrice(5000, 150)).toBe(expected)
    expect(mocks.fetchUsdJpyRate).toHaveBeenCalledOnce()
  })

  it('applies custom pricing fields from the selected bulk setting', async () => {
    const setting = {
      title_prefix: '',
      title_suffix: '',
      profit_rate: 0.3,
      ebay_fee_rate: 0.1,
      shipping_cost_jpy: 1500,
      fixed_cost_usd: 2,
    }
    const { db, insertedProducts } = makeDatabase(setting)
    await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

    const expected = calcProfit({
      purchasePriceJpy: 5000,
      jpyPerUsd: 150,
      ebayFeeRate: 0.1,
      targetProfitRate: 0.3,
      shippingUsd: 10,
      fixedCostUsd: 2,
    }).salePriceUsd
    expect(insertedProducts[0].ebay_price).toBe(expected)
  })

  it('continues extraction with a null price when exchange-rate retrieval fails', async () => {
    mocks.fetchUsdJpyRate.mockRejectedValue(new Error('rate unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { db, insertedProducts, extractionUpdates } = makeDatabase()

    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(result).toEqual({ status: 'completed' })
    expect(insertedProducts[0].ebay_price).toBeNull()
    expect(extractionUpdates).toContainEqual(expect.objectContaining({ status: 'completed', progress: 100 }))
  })
})
