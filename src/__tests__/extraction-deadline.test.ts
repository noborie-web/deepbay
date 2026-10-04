import { beforeEach, describe, expect, it, vi } from 'vitest'

// 本番で確認した不具合(2026-10-03): メルカリの抽出が90%のまま1時間以上
// 「処理中」で止まり、商品も0件だった。実行時間の上限(300秒)で強制終了される
// とAI処理の成果も取得済み商品もすべて失われる。期限を渡したら、残り時間が
// 無くなった時点でAI処理を打ち切り、取得できた商品は保存して完了させる。
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
  title: 'レア CD 新品未開封',
  price: 4700,
  description: '匿名配送で発送します。',
  images: ['https://example.com/image.jpg'],
  condition: '新品',
  sellerRatingCount: 10,
  shippingDays: 2,
  sourceUpdatedAt: null,
}

function makeDatabase() {
  const insertedProducts: Array<Record<string, unknown>> = []
  const extractionUpdates: Array<Record<string, unknown>> = []
  function resultFor(table: string) {
    if (table === 'extraction_settings') {
      return {
        data: {
          title_enabled: true, description_enabled: true, brand_enabled: true,
          ai_description_mode: 'all',
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

describe('runScrape: 実行時間の期限(deadlineAt)', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key'
    mocks.scrapeUrl.mockReset().mockResolvedValue([scrapedProduct])
    mocks.translateTitlesWithFailures.mockReset().mockResolvedValue([{ title: 'Rare CD', failed: false }])
    mocks.translateDescriptionsWithFailures.mockReset().mockResolvedValue([{ description: 'Brand new, sealed.', failed: false }])
    mocks.extractBrandsSafely.mockReset().mockResolvedValue([null])
    mocks.generateDescriptionsSafely.mockReset().mockResolvedValue([{ description: null, failed: true }])
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-10-03' })
  })

  it('AI処理に打ち切り判定(giveUp)とページ取得の打ち切り判定(shouldStop)を渡す', async () => {
    const { db } = makeDatabase()
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db, {
      deadlineAt: Date.now() + 270_000,
    })

    for (const fn of [
      mocks.translateTitlesWithFailures,
      mocks.translateDescriptionsWithFailures,
      mocks.extractBrandsSafely,
      mocks.generateDescriptionsSafely,
    ]) {
      const options = fn.mock.calls[0]?.at(-1)
      expect(typeof options?.giveUp).toBe('function')
    }
    expect(typeof mocks.scrapeUrl.mock.calls[0][1].shouldStop).toBe('function')
  })

  it('期限を渡さなければ打ち切らない(従来動作)', async () => {
    const { db, extractionUpdates } = makeDatabase()
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    const options = mocks.translateTitlesWithFailures.mock.calls[0].at(-1)
    expect(options.giveUp()).toBe(false)
    expect(mocks.scrapeUrl.mock.calls[0][1].shouldStop).toBeUndefined()
    const completed = extractionUpdates.find((u) => u.status === 'completed')
    expect((completed?.exclusion_summary as { ai_time_limited: boolean }).ai_time_limited).toBe(false)
  })

  it('期限を過ぎていればAI処理を打ち切り、取得できた商品は保存して「完了」にする', async () => {
    const { db, insertedProducts, extractionUpdates } = makeDatabase()
    // 翻訳モックが打ち切り判定を使う(=実際の翻訳関数と同じ振る舞い)
    mocks.translateTitlesWithFailures.mockImplementation(async (titles: string[], _engine: string, options) => {
      return titles.map((t) => (options?.giveUp?.() ? { title: t, failed: false } : { title: 'Rare CD', failed: false }))
    })

    const result = await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db, {
      deadlineAt: Date.now() - 1,
    })

    expect(result).toEqual({ status: 'completed' })
    // 商品は捨てずに下書きとして保存する(翻訳は元タイトルのまま)
    expect(insertedProducts).toHaveLength(1)
    expect(insertedProducts[0].ebay_title).toBe(scrapedProduct.title)
    const completed = extractionUpdates.find((u) => u.status === 'completed')
    expect(completed?.progress).toBe(100)
    expect((completed?.exclusion_summary as { ai_time_limited: boolean }).ai_time_limited).toBe(true)
  })

  it('AI処理の各段で進捗を進める(90%のまま固まって見えないようにする)', async () => {
    const { db, extractionUpdates } = makeDatabase()
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    const progresses = extractionUpdates
      .filter((u) => u.status === undefined && typeof u.progress === 'number')
      .map((u) => u.progress)
    expect(progresses).toEqual([91, 93, 95, 97, 98])
  })
})
