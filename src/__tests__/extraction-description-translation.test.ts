import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ユーザー要望: 商品説明を英訳し、メルカリ特有・国内向けの文章(ゆうパック/
// ヤマト等)をAIで削除する。ブランドも抽出する。抽出設定の「商品詳細設定」
// 「ブランド設定」のトグルとエンジンに従う。
const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  translateTitlesWithFailures: vi.fn(),
  translateDescriptionsWithFailures: vi.fn(),
  extractBrandsSafely: vi.fn(),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl }))
vi.mock('@/lib/translate', () => ({
  translateTitlesWithFailures: mocks.translateTitlesWithFailures,
  translateDescriptionsWithFailures: mocks.translateDescriptionsWithFailures,
  extractBrandsSafely: mocks.extractBrandsSafely,
}))
vi.mock('@/lib/exchange-rate', () => ({ fetchUsdJpyRate: mocks.fetchUsdJpyRate }))

import { runScrape } from '@/lib/extraction-run'

const scrapedProduct = {
  sourceUrl: 'https://jp.mercari.com/item/m1',
  sourceSite: 'mercari',
  sourceItemId: 'm1',
  title: '王の顔 韓国盤 OST 新品未開封',
  price: 47000,
  description: '韓国ドラマost 王の顔 韓国盤【新品未開封】\nゆうパックで発送します。匿名配送。\n即購入OKです。',
  images: ['https://example.com/image.jpg'],
  condition: '新品',
  sellerRatingCount: 10,
  shippingDays: 2,
  sourceUpdatedAt: null,
}

function makeDatabase(settings: Record<string, unknown>) {
  const insertedProducts: Array<Record<string, unknown>> = []
  function resultFor(table: string) {
    if (table === 'danger_sellers' || table === 'danger_words' || table === 'replace_words') return { data: [], error: null }
    if (table === 'extraction_settings') {
      return {
        data: {
          title_enabled: false,
          exclude_active_duplicate: false, exclude_title_duplicate: false, exclude_translated_duplicate: false,
          html_template_id: null,
          ...settings,
        },
        error: null,
      }
    }
    return { data: null, error: null }
  }
  const db = {
    from(table: string) {
      let updatePayload: Record<string, unknown> | null = null
      const query = {
        select() { return query },
        eq() { return query },
        single() { return Promise.resolve(resultFor(table)) },
        update(payload: Record<string, unknown>) { updatePayload = payload; return query },
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
  return { db, insertedProducts }
}

describe('extraction description translation / brand extraction', () => {
  const originalKey = process.env.OPENAI_API_KEY
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key'
    mocks.scrapeUrl.mockReset().mockResolvedValue([scrapedProduct])
    mocks.translateTitlesWithFailures.mockReset()
    mocks.translateDescriptionsWithFailures.mockReset().mockResolvedValue([
      { description: 'Korean drama OST "The King\'s Face", Korean edition. Brand new, factory sealed.', failed: false },
    ])
    mocks.extractBrandsSafely.mockReset().mockResolvedValue(['KBS Media'])
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-09-17' })
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  })

  it('商品詳細設定が有効なら、説明文を翻訳(国内向け文章を除去)して ebay_description に入れ、ブランドも設定する', async () => {
    const { db, insertedProducts } = makeDatabase({ description_enabled: true, description_engine: 'best', brand_enabled: true, brand_engine: 'normal' })

    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(mocks.translateDescriptionsWithFailures).toHaveBeenCalledWith([scrapedProduct.description], 'best')
    expect(mocks.extractBrandsSafely).toHaveBeenCalledWith(
      [{ title: scrapedProduct.title, description: scrapedProduct.description }],
      'normal',
    )
    expect(insertedProducts[0].ebay_description).toBe('Korean drama OST "The King\'s Face", Korean edition. Brand new, factory sealed.')
    expect(insertedProducts[0].ebay_description).not.toContain('ゆうパック')
    expect(insertedProducts[0].original_description).toBe(scrapedProduct.description)
    expect(insertedProducts[0].ebay_brand).toBe('KBS Media')
  })

  it('商品詳細設定・ブランド設定がOFFなら翻訳せず、元の説明文のまま登録する', async () => {
    const { db, insertedProducts } = makeDatabase({ description_enabled: false, brand_enabled: false })

    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(mocks.translateDescriptionsWithFailures).not.toHaveBeenCalled()
    expect(mocks.extractBrandsSafely).not.toHaveBeenCalled()
    expect(insertedProducts[0].ebay_description).toBe(scrapedProduct.description)
    expect(insertedProducts[0].ebay_brand).toBeNull()
  })

  it('説明文の翻訳に失敗した商品は除外せず、元の説明文のまま登録する', async () => {
    mocks.translateDescriptionsWithFailures.mockResolvedValue([{ description: scrapedProduct.description, failed: true }])
    const { db, insertedProducts } = makeDatabase({ description_enabled: true })

    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(insertedProducts).toHaveLength(1)
    expect(insertedProducts[0].ebay_description).toBe(scrapedProduct.description)
  })
})
