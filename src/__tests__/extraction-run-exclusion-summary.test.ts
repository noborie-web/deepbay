import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  translateTitlesWithFailures: vi.fn(),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl }))
vi.mock('@/lib/translate', () => ({ translateTitlesWithFailures: mocks.translateTitlesWithFailures }))
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
  const originalOpenAiKey = process.env.OPENAI_API_KEY

  beforeEach(() => {
    mocks.scrapeUrl.mockReset()
    mocks.translateTitlesWithFailures.mockReset()
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-08-30' })
  })

  afterEach(() => {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAiKey
  })

  function makeDatabase(options: {
    dangerWords?: string[]
    dangerSellerUrls?: string[]
    veroBrands?: string[]
    existingOriginalTitles?: string[]
    spotWords?: string[]
    spotCheckTitle?: boolean
    spotCheckDescription?: boolean
    ratingMin?: number | null
    shippingDaysMax?: number | null
    updatedMonthsAgo?: number | null
    priceMin?: number | null
    priceMax?: number | null
    titleEnabled?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bulkEditSetting?: Record<string, any> | null
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
      if (table === 'spot_words') {
        return { data: (options.spotWords ?? []).map((word) => ({ word })), error: null }
      }
      if (table === 'extraction_settings') {
        return {
          data: {
            title_enabled: options.titleEnabled ?? false,
            exclude_active_duplicate: false,
            exclude_title_duplicate: (options.existingOriginalTitles ?? []).length > 0,
            exclude_translated_duplicate: false,
            html_template_id: null,
            spot_check_title: options.spotCheckTitle ?? true,
            spot_check_description: options.spotCheckDescription ?? true,
            rating_min: options.ratingMin ?? null,
            shipping_days_max: options.shippingDaysMax ?? null,
            updated_months_ago: options.updatedMonthsAgo ?? null,
            price_min: options.priceMin ?? null,
            price_max: options.priceMax ?? null,
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
      if (table === 'bulk_edit_settings') return { data: options.bulkEditSetting ?? null, error: null }
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
      sold_out_excluded: 0,
      no_image_excluded: 0,
      no_price_excluded: 0,
      danger_word_excluded: 1,
      vero_excluded: 0,
      individual_danger_seller_excluded: 0,
      spot_word_excluded: 0,
      low_rating_excluded: 0,
      slow_shipping_excluded: 0,
      stale_excluded: 0,
      price_range_excluded: 0,
      bulk_edit_rating_excluded: 0,
      bulk_edit_shipping_days_excluded: 0,
      bulk_edit_updated_months_excluded: 0,
      bulk_edit_price_range_excluded: 0,
      bulk_edit_bad_rating_excluded: 0,
      translated_title_failed_excluded: 0,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 0,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })

  // ユーザー要望: 公式ツールの「除外詳細」と同等の項目(Phase 1)。
  // 売り切れ・画像なし・価格取得不可はスクレイパーが既に取得している
  // データを使って抽出時に自動除外できるため、まずこの3項目を追加した。
  it('売り切れ・画像なし・価格取得不可の商品を自動的に除外し、件数を記録する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', availability: 'sold_out' }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', images: [] }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/3', sourceItemId: 'item-3', price: null }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/4', sourceItemId: 'item-4' }),
    ])
    const { db, extractionUpdates } = makeDatabase()

    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(result.status).toBe('completed')
    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toEqual({
      detail_fetch_count: 4,
      sold_out_excluded: 1,
      no_image_excluded: 1,
      no_price_excluded: 1,
      danger_word_excluded: 0,
      vero_excluded: 0,
      individual_danger_seller_excluded: 0,
      spot_word_excluded: 0,
      low_rating_excluded: 0,
      slow_shipping_excluded: 0,
      stale_excluded: 0,
      price_range_excluded: 0,
      bulk_edit_rating_excluded: 0,
      bulk_edit_shipping_days_excluded: 0,
      bulk_edit_updated_months_excluded: 0,
      bulk_edit_price_range_excluded: 0,
      bulk_edit_bad_rating_excluded: 0,
      translated_title_failed_excluded: 0,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 0,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })

  it('在庫状況(availability)を取得できないサイトの商品は売り切れ判定せず素通りする', async () => {
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ availability: undefined })])
    const { db, extractionUpdates } = makeDatabase()

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({ sold_out_excluded: 0, completed_count: 1 })
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
      sold_out_excluded: 0,
      no_image_excluded: 0,
      no_price_excluded: 0,
      danger_word_excluded: 0,
      vero_excluded: 1,
      individual_danger_seller_excluded: 0,
      spot_word_excluded: 0,
      low_rating_excluded: 0,
      slow_shipping_excluded: 0,
      stale_excluded: 0,
      price_range_excluded: 0,
      bulk_edit_rating_excluded: 0,
      bulk_edit_shipping_days_excluded: 0,
      bulk_edit_updated_months_excluded: 0,
      bulk_edit_price_range_excluded: 0,
      bulk_edit_bad_rating_excluded: 0,
      translated_title_failed_excluded: 0,
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
      sold_out_excluded: 0,
      no_image_excluded: 0,
      no_price_excluded: 0,
      danger_word_excluded: 0,
      vero_excluded: 0,
      individual_danger_seller_excluded: 1,
      spot_word_excluded: 0,
      low_rating_excluded: 0,
      slow_shipping_excluded: 0,
      stale_excluded: 0,
      price_range_excluded: 0,
      bulk_edit_rating_excluded: 0,
      bulk_edit_shipping_days_excluded: 0,
      bulk_edit_updated_months_excluded: 0,
      bulk_edit_price_range_excluded: 0,
      bulk_edit_bad_rating_excluded: 0,
      translated_title_failed_excluded: 0,
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

  // ユーザー要望: 公式ツールの「除外詳細」と同等の項目(Phase 2)。評価数・
  // 発送日数・最終更新月・価格範囲・スポット文字の閾値を抽出設定に保存
  // できるようにし、抽出時にも自動適用する。
  it('スポット文字がタイトルまたは商品説明に含まれる商品を自動的に除外する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', title: '難あり ジャケット' }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', description: 'シミあり' }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/3', sourceItemId: 'item-3', title: '美品 ジャケット' }),
    ])
    const { db, extractionUpdates } = makeDatabase({ spotWords: ['難あり', 'シミ'] })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({ spot_word_excluded: 2, completed_count: 1 })
  })

  it('評価数が閾値未満のセラーの商品を自動的に除外する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', sellerRatingCount: 5 }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', sellerRatingCount: 50 }),
    ])
    const { db, extractionUpdates } = makeDatabase({ ratingMin: 10 })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({ low_rating_excluded: 1, completed_count: 1 })
  })

  it('発送日数が閾値を超える商品を自動的に除外する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', shippingDays: 10 }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', shippingDays: 1 }),
    ])
    const { db, extractionUpdates } = makeDatabase({ shippingDaysMax: 3 })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({ slow_shipping_excluded: 1, completed_count: 1 })
  })

  it('最終更新日が指定月数より前の商品を自動的に除外する', async () => {
    const old = new Date()
    old.setMonth(old.getMonth() - 6)
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', sourceUpdatedAt: old.toISOString() }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', sourceUpdatedAt: new Date().toISOString() }),
    ])
    const { db, extractionUpdates } = makeDatabase({ updatedMonthsAgo: 3 })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({ stale_excluded: 1, completed_count: 1 })
  })

  it('価格範囲外の商品を自動的に除外する', async () => {
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', price: 500 }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', price: 50000 }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/3', sourceItemId: 'item-3', price: 5000 }),
    ])
    const { db, extractionUpdates } = makeDatabase({ priceMin: 1000, priceMax: 10000 })

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({ price_range_excluded: 2, completed_count: 1 })
  })

  it('閾値が未設定(null)ならPhase 2の各フィルタは何も除外しない(既存挙動を維持)', async () => {
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct()])
    const { db, extractionUpdates } = makeDatabase()

    await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({
      spot_word_excluded: 0,
      low_rating_excluded: 0,
      slow_shipping_excluded: 0,
      stale_excluded: 0,
      price_range_excluded: 0,
      completed_count: 1,
    })
  })

  // ユーザー要望: 公式ツールの「除外詳細」と同等の項目(Phase 3)。以前は
  // タイトル翻訳が一括処理で1件でも失敗すると全件が元タイトルへ
  // フォールバックし、失敗商品を区別できなかった。商品単位でエラーを
  // 捕捉し、失敗した商品だけを除外するようにした。
  it('タイトル翻訳に失敗した商品だけを自動的に除外し、件数を記録する', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mocks.scrapeUrl.mockResolvedValue([
      scrapedProduct({ sourceItemId: 'item-1', title: '成功する商品' }),
      scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', title: '失敗する商品' }),
    ])
    mocks.translateTitlesWithFailures.mockResolvedValue([
      { title: 'Successful Item', failed: false },
      { title: '失敗する商品', failed: true },
    ])
    const { db, extractionUpdates, insertedProducts } = makeDatabase({ titleEnabled: true })

    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(result.status).toBe('completed')
    expect(insertedProducts).toHaveLength(1)
    expect(insertedProducts[0].original_title).toBe('成功する商品')
    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({
      translated_title_failed_excluded: 1,
      completed_count: 1,
    })
  })

  it('翻訳が全体的に失敗した場合(APIキー不正等)は、既存互換で全件を元タイトルにフォールバックする(商品を除外しない)', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ title: '商品タイトル' })])
    mocks.translateTitlesWithFailures.mockRejectedValue(new Error('APIキーが不正です'))
    const { db, extractionUpdates, insertedProducts } = makeDatabase({ titleEnabled: true })

    const result = await runScrape('user-1', 'extraction-1', 'https://example.com/search', null, db)

    expect(result.status).toBe('completed')
    expect(insertedProducts).toHaveLength(1)
    expect(insertedProducts[0].original_title).toBe('商品タイトル')
    const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
    expect(completedUpdate?.exclusion_summary).toMatchObject({
      translated_title_failed_excluded: 0,
      completed_count: 1,
    })
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
      sold_out_excluded: 0,
      no_image_excluded: 0,
      no_price_excluded: 0,
      danger_word_excluded: 0,
      vero_excluded: 0,
      individual_danger_seller_excluded: 0,
      spot_word_excluded: 0,
      low_rating_excluded: 0,
      slow_shipping_excluded: 0,
      stale_excluded: 0,
      price_range_excluded: 0,
      bulk_edit_rating_excluded: 0,
      bulk_edit_shipping_days_excluded: 0,
      bulk_edit_updated_months_excluded: 0,
      bulk_edit_price_range_excluded: 0,
      bulk_edit_bad_rating_excluded: 0,
      translated_title_failed_excluded: 0,
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
      sold_out_excluded: 0,
      no_image_excluded: 0,
      no_price_excluded: 0,
      danger_word_excluded: 0,
      vero_excluded: 0,
      individual_danger_seller_excluded: 0,
      spot_word_excluded: 0,
      low_rating_excluded: 0,
      slow_shipping_excluded: 0,
      stale_excluded: 0,
      price_range_excluded: 0,
      bulk_edit_rating_excluded: 0,
      bulk_edit_shipping_days_excluded: 0,
      bulk_edit_updated_months_excluded: 0,
      bulk_edit_price_range_excluded: 0,
      bulk_edit_bad_rating_excluded: 0,
      translated_title_failed_excluded: 0,
      active_duplicate_excluded: 0,
      title_duplicate_excluded: 0,
      translated_duplicate_excluded: 0,
      completed_count: 1,
    })
  })

  // ユーザー要望: 公式ツールのように、一括編集設定(プロファイル)ごとに
  // 除外条件を個別に有効・無効切り替えできるようにしたい。
  describe('一括編集設定(プロファイル)ごとの除外条件切り替え', () => {
    it('一括編集設定でVero除外が無効の場合、Veroブランドが一致しても除外しない', async () => {
      mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ title: 'NIKE スニーカー' })])
      const { db, extractionUpdates } = makeDatabase({
        veroBrands: ['NIKE'],
        bulkEditSetting: { id: 'bulk-1', vero_exclude_enabled: false },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({ vero_excluded: 0, completed_count: 1 })
    })

    it('一括編集設定で危険単語除外が無効の場合、危険単語が一致しても除外しない', async () => {
      mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ title: 'ジャンク品 フィギュア' })])
      const { db, extractionUpdates } = makeDatabase({
        dangerWords: ['ジャンク'],
        bulkEditSetting: { id: 'bulk-1', danger_word_exclude_enabled: false },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({ danger_word_excluded: 0, completed_count: 1 })
    })

    it('一括編集設定で危険セラー除外が無効の場合、登録済み危険セラーの商品でも除外しない', async () => {
      mocks.scrapeUrl.mockResolvedValue([
        scrapedProduct({ sellerUrl: 'https://jp.mercari.com/user/profile/999' }),
      ])
      const { db, extractionUpdates } = makeDatabase({
        dangerSellerUrls: ['https://jp.mercari.com/user/profile/999'],
        bulkEditSetting: { id: 'bulk-1', danger_seller_exclude_enabled: false },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({ individual_danger_seller_excluded: 0, completed_count: 1 })
    })

    it('一括編集設定の価格範囲を有効にすると、グローバル抽出設定による除外(段階①)に加えて、プロファイルの閾値でも追加除外する(段階②)', async () => {
      mocks.scrapeUrl.mockResolvedValue([
        scrapedProduct({ sourceItemId: 'item-1', price: 50 }),
        scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', price: 500 }),
        scrapedProduct({ sourceUrl: 'https://example.com/item/3', sourceItemId: 'item-3', price: 5000 }),
      ])
      const { db, extractionUpdates } = makeDatabase({
        priceMin: 100, // 段階①: price=50の商品のみ除外
        bulkEditSetting: { id: 'bulk-1', price_range_enabled: true, price_min: 1000, price_max: 10000 }, // 段階②: price=500の商品を追加除外
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({
        price_range_excluded: 1,
        bulk_edit_price_range_excluded: 1,
        completed_count: 1,
      })
    })

    it('一括編集設定の価格範囲が無効(有効チェックが入っていない)の場合、閾値が入力されていても段階②の追加除外は適用しない', async () => {
      mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ price: 500 })])
      const { db, extractionUpdates } = makeDatabase({
        bulkEditSetting: { id: 'bulk-1', price_range_enabled: false, price_min: 1000, price_max: 10000 },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({ price_range_excluded: 0, bulk_edit_price_range_excluded: 0, completed_count: 1 })
    })

    it('一括編集設定全体が無効(is_enabled:false)の場合、プロファイルが選択されていても一切適用しない', async () => {
      mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ title: 'NIKE スニーカー' })])
      const { db, extractionUpdates } = makeDatabase({
        veroBrands: ['NIKE'],
        priceMin: 100,
        bulkEditSetting: {
          id: 'bulk-1',
          is_enabled: false,
          vero_exclude_enabled: true,
          price_range_enabled: true,
          price_min: 1,
          price_max: 2,
        },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      // is_enabled:falseなので、プロファイル自身のVero除外(有効指定)は使われず、
      // 未選択時と同じくグローバル抽出設定(veroBrands指定なし→veroは常時有効)
      // にフォールバックし、NIKEは除外される。price_range_excludedはグローバル
      // priceMin=100を使うため0件(price=5000は範囲内)。
      expect(completedUpdate?.exclusion_summary).toMatchObject({ vero_excluded: 1, price_range_excluded: 0, completed_count: 0 })
    })

    it('一括編集設定の「抽出時の価格自動計算」を無効にすると、他の除外設定は有効なままebay_priceだけ自動計算しない', async () => {
      mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ title: 'NIKE スニーカー', price: 5000 })])
      const { db, insertedProducts } = makeDatabase({
        veroBrands: ['NIKE'],
        bulkEditSetting: {
          id: 'bulk-1',
          is_enabled: true,
          auto_pricing_enabled: false,
          vero_exclude_enabled: false,
        },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      expect(insertedProducts).toHaveLength(1)
      expect(insertedProducts[0].ebay_price).toBeNull()
    })

    it('一括編集設定の評価数除外を有効にすると、その閾値で追加除外する(段階②)', async () => {
      mocks.scrapeUrl.mockResolvedValue([
        scrapedProduct({ sourceItemId: 'item-1', sellerRatingCount: 5 }),
        scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', sellerRatingCount: 50 }),
      ])
      const { db, extractionUpdates } = makeDatabase({
        bulkEditSetting: { id: 'bulk-1', rating_exclude_enabled: true, rating_min: 10 },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({ bulk_edit_rating_excluded: 1, completed_count: 1 })
    })

    // ユーザー要望: 公式ツールの「低評価数除外」に相当する新機能。セラーの
    // 悪い評価件数(sellerBadRatingCount)が許容数を超えたら追加除外する。
    it('一括編集設定の低評価数除外を有効にすると、セラーの悪い評価件数が許容数を超える商品を追加除外する', async () => {
      mocks.scrapeUrl.mockResolvedValue([
        scrapedProduct({ sourceItemId: 'item-1', sellerBadRatingCount: 5 }),
        scrapedProduct({ sourceUrl: 'https://example.com/item/2', sourceItemId: 'item-2', sellerBadRatingCount: 0 }),
      ])
      const { db, extractionUpdates } = makeDatabase({
        bulkEditSetting: { id: 'bulk-1', low_rating_exclude_enabled: true, low_rating_max: 1 },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({ bulk_edit_bad_rating_excluded: 1, completed_count: 1 })
    })

    it('低評価数を取得できない商品(null)は判定せず素通りする', async () => {
      mocks.scrapeUrl.mockResolvedValue([scrapedProduct({ sellerBadRatingCount: undefined })])
      const { db, extractionUpdates } = makeDatabase({
        bulkEditSetting: { id: 'bulk-1', low_rating_exclude_enabled: true, low_rating_max: 1 },
      })

      await runScrape('user-1', 'extraction-1', 'https://example.com/search', 'bulk-1', db)

      const completedUpdate = extractionUpdates.find((u) => u.status === 'completed')
      expect(completedUpdate?.exclusion_summary).toMatchObject({ bulk_edit_bad_rating_excluded: 0, completed_count: 1 })
    })
  })
})
