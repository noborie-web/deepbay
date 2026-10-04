import { beforeEach, describe, expect, it, vi } from 'vitest'

// 本番で確認した不具合(2026-10-03): 600件規模のメルカリ抽出でAI処理が直列に
// 積み上がり、実行時間の上限(300秒)を超えて商品0件で失敗していた。
// 説明文の翻訳はタイトル翻訳・ブランド抽出と依存関係が無いので同時に走らせる。
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

function product(id: string, title: string, description: string) {
  return {
    sourceUrl: `https://jp.mercari.com/item/${id}`,
    sourceSite: 'mercari',
    sourceItemId: id,
    title,
    price: 4700,
    description,
    images: ['https://example.com/image.jpg'],
    condition: '新品',
    sellerRatingCount: 10,
    shippingDays: 2,
    sourceUpdatedAt: null,
  }
}

function makeDatabase() {
  const insertedProducts: Array<Record<string, unknown>> = []
  function resultFor(table: string) {
    if (table === 'extraction_settings') {
      return {
        data: {
          title_enabled: true, description_enabled: true, brand_enabled: true,
          ai_description_mode: 'off',
          exclude_active_duplicate: false, exclude_title_duplicate: false, exclude_translated_duplicate: false,
          html_template_id: null,
        },
        error: null,
      }
    }
    if (table === 'extractions') return { data: null, error: null }
    return { data: [], error: null }
  }
  const db = {
    from(table: string) {
      let updatePayload: Record<string, unknown> | null = null
      const query = {
        select() { return query },
        eq() { return query },
        is() { return query },
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

describe('runScrape: AI処理の並行実行', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key'
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-10-03' })
    mocks.generateDescriptionsSafely.mockReset().mockResolvedValue([])
  })

  it('説明文の翻訳をタイトル翻訳の完了前に開始する', async () => {
    const order: string[] = []
    mocks.scrapeUrl.mockReset().mockResolvedValue([product('m1', 'レアCD', '匿名配送')])
    mocks.translateDescriptionsWithFailures.mockReset().mockImplementation(async (descriptions: string[]) => {
      order.push('description:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('description:end')
      return descriptions.map(() => ({ description: 'Brand new, sealed.', failed: false }))
    })
    mocks.translateTitlesWithFailures.mockReset().mockImplementation(async (titles: string[]) => {
      order.push('title:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('title:end')
      return titles.map(() => ({ title: 'Rare CD', failed: false }))
    })
    mocks.extractBrandsSafely.mockReset().mockResolvedValue([null])

    const { db, insertedProducts } = makeDatabase()
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    // 説明文翻訳がタイトル翻訳の終了を待っていない
    expect(order.indexOf('description:start')).toBeLessThan(order.indexOf('title:end'))
    expect(insertedProducts[0].ebay_description).toBe('Brand new, sealed.')
  })

  it('タイトル翻訳に失敗した商品の説明文は、残った商品とずれずに対応する', async () => {
    mocks.scrapeUrl.mockReset().mockResolvedValue([
      product('m1', 'タイトル1', '説明1'),
      product('m2', 'タイトル2', '説明2'),
      product('m3', 'タイトル3', '説明3'),
    ])
    // 2件目だけタイトル翻訳に失敗 → 除外される
    mocks.translateTitlesWithFailures.mockReset().mockResolvedValue([
      { title: 'Title 1', failed: false },
      { title: 'タイトル2', failed: true },
      { title: 'Title 3', failed: false },
    ])
    mocks.translateDescriptionsWithFailures.mockReset().mockImplementation(async (descriptions: string[]) =>
      descriptions.map((d) => ({ description: `EN(${d})`, failed: false })),
    )
    mocks.extractBrandsSafely.mockReset().mockResolvedValue([null, null])

    const { db, insertedProducts } = makeDatabase()
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    // 説明文の翻訳は除外前の全3件に対して呼ばれる(タイトル翻訳と並行のため)
    expect(mocks.translateDescriptionsWithFailures.mock.calls[0][0]).toEqual(['説明1', '説明2', '説明3'])
    // 保存されるのは除外後の2件で、説明文が1件ずれていない
    expect(insertedProducts.map((p) => [p.ebay_title, p.ebay_description])).toEqual([
      ['Title 1', 'EN(説明1)'],
      ['Title 3', 'EN(説明3)'],
    ])
    // ブランド抽出にも除外後の商品が、元の説明文とともに渡る
    expect(mocks.extractBrandsSafely.mock.calls[0][0]).toEqual([
      { title: 'Title 1', description: '説明1' },
      { title: 'Title 3', description: '説明3' },
    ])
  })
})
