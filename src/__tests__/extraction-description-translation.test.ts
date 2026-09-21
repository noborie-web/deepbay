import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ユーザー要望: 商品説明を英訳し、メルカリ特有・国内向けの文章(ゆうパック/
// ヤマト等)をAIで削除する。ブランドも抽出する。抽出設定の「商品詳細設定」
// 「ブランド設定」のトグルとエンジンに従う。
const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  translateTitlesWithFailures: vi.fn(),
  translateDescriptionsWithFailures: vi.fn(),
  extractBrandsSafely: vi.fn(),
  generateDescriptionsSafely: vi.fn(),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl }))
vi.mock('@/lib/translate', () => ({
  translateTitlesWithFailures: mocks.translateTitlesWithFailures,
  translateDescriptionsWithFailures: mocks.translateDescriptionsWithFailures,
  extractBrandsSafely: mocks.extractBrandsSafely,
  generateDescriptionsSafely: mocks.generateDescriptionsSafely,
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
    mocks.generateDescriptionsSafely.mockReset().mockResolvedValue([])
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

  // ユーザー要望: 説明文をAIで生成する。'missing' は説明文が取れなかった商品だけ、
  // 'all' は全商品(元の説明文も材料にする)。
  it("ai_description_mode='missing' なら説明文が空の商品だけAIで生成し、元の説明文がある商品は翻訳のまま", async () => {
    const noDescription = { ...scrapedProduct, sourceItemId: 'z2', sourceUrl: 'https://paypayfleamarket.yahoo.co.jp/item/z2', sourceSite: 'yahoo_flea', description: '', condition: '目立った傷や汚れなし', category: 'ソフト', rawData: { brand: 'Nintendo', hashtags: ['ファミコン'] } }
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct, noDescription])
    mocks.translateDescriptionsWithFailures.mockResolvedValue([
      { description: 'Translated description', failed: false },
      { description: '', failed: false },
    ])
    mocks.extractBrandsSafely.mockResolvedValue(['KBS Media', null])
    mocks.generateDescriptionsSafely.mockResolvedValue([{ description: 'Generated English description', failed: false }])
    const { db, insertedProducts } = makeDatabase({ description_enabled: true, description_engine: 'high', ai_description_mode: 'missing' })

    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(mocks.generateDescriptionsSafely).toHaveBeenCalledWith([
      { title: noDescription.title, condition: '目立った傷や汚れなし', category: 'ソフト', brand: 'Nintendo', hashtags: ['ファミコン'], originalDescription: '' },
    ], 'high')
    expect(insertedProducts[0].ebay_description).toBe('Translated description')
    expect(insertedProducts[0].ai_description_generated_at).toBeNull()
    expect(insertedProducts[1].ebay_description).toBe('Generated English description')
    expect(insertedProducts[1].ai_description_generated_at).toBeTruthy()
  })

  it("ai_description_mode='all' なら全商品を元の説明文も材料にして生成する", async () => {
    mocks.generateDescriptionsSafely.mockResolvedValue([{ description: 'Generated from original', failed: false }])
    const { db, insertedProducts } = makeDatabase({ description_enabled: true, ai_description_mode: 'all' })

    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(mocks.generateDescriptionsSafely).toHaveBeenCalledTimes(1)
    expect(mocks.generateDescriptionsSafely.mock.calls[0][0][0]).toMatchObject({ title: scrapedProduct.title, originalDescription: scrapedProduct.description, brand: 'KBS Media' })
    expect(insertedProducts[0].ebay_description).toBe('Generated from original')
    expect(insertedProducts[0].original_description).toBe(scrapedProduct.description)
  })

  it("ai_description_mode='off' なら生成しない", async () => {
    const { db } = makeDatabase({ description_enabled: true, ai_description_mode: 'off' })
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)
    expect(mocks.generateDescriptionsSafely).not.toHaveBeenCalled()
  })

  // ユーザー指摘: 翻訳結果に「メルカリ便で発送」等が残ることがある。残っていた
  // 商品は事実ベースのAI生成に切り替える(AI生成OFFでも適用)。
  it('翻訳結果に国内向けの文言が残っていたら、その商品だけAI生成に切り替える', async () => {
    mocks.translateDescriptionsWithFailures.mockResolvedValue([
      { description: 'Korean drama OST. Shipped by Rakuraku Mercari-bin with anonymous shipping.', failed: false },
    ])
    mocks.generateDescriptionsSafely.mockResolvedValue([{ description: 'Korean drama OST "The King\'s Face", Korean edition. Brand new, sealed.', failed: false }])
    const { db, insertedProducts } = makeDatabase({ description_enabled: true, ai_description_mode: 'off' })

    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(mocks.generateDescriptionsSafely).toHaveBeenCalledTimes(1)
    expect(mocks.generateDescriptionsSafely.mock.calls[0][0][0]).toMatchObject({ originalDescription: scrapedProduct.description })
    expect(insertedProducts[0].ebay_description).toBe('Korean drama OST "The King\'s Face", Korean edition. Brand new, sealed.')
  })
})
