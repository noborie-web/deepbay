import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  translateTitles: vi.fn(),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl }))
vi.mock('@/lib/translate', () => ({ translateTitles: mocks.translateTitles }))
vi.mock('@/lib/exchange-rate', () => ({ fetchUsdJpyRate: mocks.fetchUsdJpyRate }))

import { runScrape } from '@/lib/extraction-run'

function scrapedProduct(overrides: Record<string, unknown> = {}) {
  return {
    sourceUrl: 'https://example.com/item/1',
    sourceSite: 'mercari',
    sourceItemId: 'item-1',
    title: '普通の商品',
    price: 5000,
    description: '説明',
    images: ['https://example.com/image.jpg'],
    condition: '中古',
    sellerRatingCount: 10,
    shippingDays: 2,
    sourceUpdatedAt: null,
    ...overrides,
  }
}

// ユーザー要望: 既存ツール(公式)の「除外詳細」に相当する、抽出時の各段階の
// 除外件数を記録・可視化する機能。まず現在実際に実行されている除外
// (危険単語・active重複・タイトル重複・翻訳後タイトル重複)の件数を記録する。
describe('runScrape: 除外詳細(exclusion_summary)の記録', () => {
  beforeEach(() => {
    mocks.scrapeUrl.mockReset()
    mocks.translateTitles.mockReset()
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-08-30' })
  })

  function makeDatabase(options: {
    dangerWords?: string[]
    dangerSellerUrls?: string[]
    veroBrands?: string[]
    existingOriginalTitles?: string[]
  } = {}) {
    const extractionUpdates: Array<Record<string, unknown>> = []
    const insertedProducts: Array<Record<string, unknown>> = []

    function resultFor(table: string) {
      if (table === 'danger_sellers') {
        return { data: (options.dangerSellerUrls ?? []).map((seller_url) => ({ seller_url })), error: null }
      }
      if (table === 'replace_words') return { data: [], error: null }
      if (table === 'danger_words') {
        return { data: (options.dangerWords ?? []).map((word) => ({ word })), error: null }
      }
      if (table === 'vero_brands') {
        return { data: (options.veroBrands ?? []).map((brand) => ({ brand })), error: null }
      }
      if (table === 'extraction_settings') {
        return {
          data: {
            title_enabled: false,
            exclude_active_duplicate: false,
            exclude_title_duplicate: (options.existingOriginalTitles ?? []).length > 0,
            exclude_translated_duplicate: false,
            html_template_id: null,
          },
          error: null,
        }
      }
      if (table === 'products') {
        return {
          data: (options.existingOriginalTitles ?? []).map((title) => ({ original_title: title })),
          error: null,
        }
      }
      if (table === 'bulk_edit_settings') return { data: null, error: null }
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
    return { db, extractionUpdates, insertedProducts }
  }

  it('危険単語で除外された件数を記録する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', title: 'ジャンク品 フィギュア' }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', title: '美品 フィギュア' }),
    ])
    const { db, extractionUpdates } = makeDatabase({ dangerWords: ['ジャンク'] })

    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(result.status).toBe('completed')
    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toEqual({
      detail_fetch_count: 2,
      danger_word_excluded: 1,
      vero_excluded: 0,
      individual_danger_seller_excluded: 0,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 0,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })

  // ユーザー確認: 「Vero除外は確実に実行されていますか？」→調査の結果、
  // これまで抽出パイプラインには一切含まれておらず、商品編集画面の
  // 「除外」タブでユーザーが手動実行しない限り除外されない仕様だった
  // (危険単語と違い自動セーフティネットが無かった)。危険単語と同様に
  // 抽出時にも自動除外するようにした。
  it('登録済みVeroブランドがタイトルに含まれる商品は自動的に除外され、件数が記録される', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', title: 'NIKE スニーカー 新品' }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', title: 'ノーブランド スニーカー' }),
    ])
    const { db, extractionUpdates } = makeDatabase({ veroBrands: ['NIKE'] })

    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(result.status).toBe('completed')
    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toEqual({
      detail_fetch_count: 2,
      danger_word_excluded: 0,
      vero_excluded: 1,
      individual_danger_seller_excluded: 0,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 0,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })

  it('Veroブランドが未登録なら何も除外しない(既存挙動を維持)', async () => {
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ title: 'NIKE スニーカー' })])
    const { db, extractionUpdates } = makeDatabase()

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({ vero_excluded: 0, completed_count: 1 })
  })

  // ユーザー要望: 「危険セラーの除外は必須です」。検索結果内に登録済み
  // 危険セラーの商品が混ざっている場合、その商品だけを除外する
  // (抽出URL自体が危険セラーのページである場合の既存チェックとは別)。
  it('検索結果内の個別商品が登録済み危険セラーの場合、その商品だけを除外する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({
        sourceItemId: 'item-1',
        title: '危険セラーの商品',
        sellerUrl: 'https://jp.mercari.com/user/profile/999?ref=search',
      }),
      scrapedProduct({
        sourceUrl: 'https://example.com/item/2',
        sourceItemId: 'item-2',
        title: '安全な商品',
        sellerUrl: 'https://jp.mercari.com/user/profile/111',
      }),
    ])
    const { db, extractionUpdates } = makeDatabase({
      dangerSellerUrls: ['https://jp.mercari.com/user/profile/999'],
    })

    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(result.status).toBe('completed')
    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toEqual({
      detail_fetch_count: 2,
      danger_word_excluded: 0,
      vero_excluded: 0,
      individual_danger_seller_excluded: 1,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 0,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })

  it('sellerUrlを取得できない商品(未対応サイト等)は危険セラー登録があっても判定せず素通りする', async () => {
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ sellerUrl: undefined })])
    const { db, extractionUpdates } = makeDatabase({
      dangerSellerUrls: ['https://jp.mercari.com/user/profile/999'],
    })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({
      individual_danger_seller_excluded: 0,
      completed_count: 1,
    })
  })

  // ラクマ等、検索結果に出品者情報がなく商品ごとの追加ページアクセスが
  // 必要なサイトのコストを避けるため、危険セラーが1件も登録されていない
  // 場合はscrapeUrlにfetchSellerInfo:falseを渡す。
  it('危険セラーが登録されていなければfetchSellerInfo:falseでscrapeUrlを呼ぶ', async () => {
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct()])
    const { db } = makeDatabase()

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(mocks.scrapeUrl).toHaveBeenCalledWith(
      'https://example.com/search',
      expect.objectContaining({ fetchSellerInfo: false }),
    )
  })

  it('危険セラーが1件でも登録されていればfetchSellerInfo:trueでscrapeUrlを呼ぶ', async () => {
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct()])
    const { db } = makeDatabase({ dangerSellerUrls: ['https://jp.mercari.com/user/profile/999'] })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(mocks.scrapeUrl).toHaveBeenCalledWith(
      'https://example.com/search',
      expect.objectContaining({ fetchSellerInfo: true }),
    )
  })

  it('タイトル重複で除外された件数を記録する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', title: '既存商品と同じタイトル' }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', title: '新しい商品' }),
    ])
    const { db, extractionUpdates } = makeDatabase({ existingOriginalTitles: ['既存商品と同じタイトル'] })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toEqual({
      detail_fetch_count: 2,
      danger_word_excluded: 0,
      vero_excluded: 0,
      individual_danger_seller_excluded: 0,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 1,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })

  it('除外がなければ全件が取得完了件数になる', async () => {
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct()])
    const { db, extractionUpdates } = makeDatabase()

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toEqual({
      detail_fetch_count: 1,
      danger_word_excluded: 0,
      vero_excluded: 0,
      individual_danger_seller_excluded: 0,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 0,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })
})
