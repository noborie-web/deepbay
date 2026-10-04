import { beforeEach, describe, expect, it, vi } from 'vitest'

// ユーザー指摘(2026-10-04): miyabi-24(US)で取得したあと、同じURLを
// akebono-32(UK/AU)で取得すると全件が「タイトル重複除外」になり、
// 取得完了件数が2件しか残らなかった。同じ商品をUSとUK/AUの別アカウントに
// 出品するのは正常な運用なので、重複判定は出品セラーごとに行う。
const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  translateTitlesWithFailures: vi.fn(),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl }))
vi.mock('@/lib/translate', () => ({ translateTitlesWithFailures: mocks.translateTitlesWithFailures }))
vi.mock('@/lib/exchange-rate', () => ({ fetchUsdJpyRate: mocks.fetchUsdJpyRate }))

import { runScrape } from '@/lib/extraction-run'

const scrapedProduct = {
  sourceUrl: 'https://jp.mercari.com/item/m1',
  sourceSite: 'mercari',
  sourceItemId: 'm1',
  title: '既にUSで取得済みの商品',
  price: 5000,
  description: '説明',
  images: ['https://example.com/image.jpg'],
  condition: '中古',
  sellerRatingCount: 10,
  shippingDays: 2,
  sourceUpdatedAt: null,
}

function makeDatabase(sellerAccountId: string | null, sellerAccounts?: Array<{ id: string; ebay_connected_at: string | null }>) {
  const productFilters: Array<[string, unknown]> = []
  const productQueries: Array<Array<[string, unknown]>> = []
  const insertedProducts: Array<Record<string, unknown>> = []

  function resultFor(table: string) {
    if (table === 'extractions') return { data: { seller_account_id: sellerAccountId }, error: null }
    if (table === 'extraction_settings') {
      return {
        data: {
          title_enabled: false,
          exclude_active_duplicate: false,
          exclude_title_duplicate: true,
          exclude_translated_duplicate: false,
          html_template_id: null,
        },
        error: null,
      }
    }
    if (table === 'products') {
      // 他セラー(miyabi-24)の商品。セラーで絞り込めていれば返ってこない想定の
      // データだが、テストでは常に返して「絞り込み条件」自体を検証する。
      return { data: [{ original_title: scrapedProduct.title }], error: null }
    }
    if (table === 'seller_accounts') return { data: sellerAccounts ?? [], error: null }
    return { data: [], error: null }
  }

  const db = {
    from(table: string) {
      let updatePayload: Record<string, unknown> | null = null
      const filters: Array<[string, unknown]> = []
      if (table === 'products') productQueries.push(filters)
      const query = {
        select() { return query },
        eq(column: string, value: unknown) {
          if (table === 'products') { productFilters.push([column, value]); filters.push([column, value]) }
          return query
        },
        is(column: string, value: unknown) {
          if (table === 'products') { productFilters.push([column, value]); filters.push([column, value]) }
          return query
        },
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
  return { db, productFilters, productQueries, insertedProducts }
}

describe('runScrape: 重複判定は出品セラーごとに行う', () => {
  beforeEach(() => {
    mocks.scrapeUrl.mockReset().mockResolvedValue([scrapedProduct])
    mocks.translateTitlesWithFailures.mockReset()
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150, date: '2026-10-04' })
  })

  it('出品セラーが設定されていれば、そのセラーの商品だけと比較する', async () => {
    const { db, productFilters } = makeDatabase('akebono-32-uuid')
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(productFilters).toContainEqual(['extractions.seller_account_id', 'akebono-32-uuid'])
  })

  it('出品セラー未設定の抽出どうしは、従来どおり互いに比較する', async () => {
    const { db, productFilters } = makeDatabase(null)
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(productFilters).toContainEqual(['extractions.seller_account_id', null])
  })

  it('最初に接続したセラーの抽出は、抽出元が残っていない商品(CSV取り込み等)とも比較する', async () => {
    const { db, productQueries } = makeDatabase('miyabi-24-uuid', [
      { id: 'miyabi-24-uuid', ebay_connected_at: '2026-01-01T00:00:00Z' },
      { id: 'akebono-32-uuid', ebay_connected_at: '2026-09-25T00:00:00Z' },
    ])
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(productQueries.some((f) => f.some(([c, v]) => c === 'extraction_id' && v === null))).toBe(true)
  })

  it('あとから接続したセラーの抽出は、抽出元が残っていない商品とは比較しない', async () => {
    const { db, productQueries } = makeDatabase('akebono-32-uuid', [
      { id: 'miyabi-24-uuid', ebay_connected_at: '2026-01-01T00:00:00Z' },
      { id: 'akebono-32-uuid', ebay_connected_at: '2026-09-25T00:00:00Z' },
    ])
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(productQueries.some((f) => f.some(([c, v]) => c === 'extraction_id' && v === null))).toBe(false)
  })

  it('ユーザー単位の絞り込みは従来どおり残す', async () => {
    const { db, productFilters } = makeDatabase('akebono-32-uuid')
    await runScrape('user-1', 'extraction-1', 'https://jp.mercari.com/search', null, db)

    expect(productFilters).toContainEqual(['user_id', 'user-1'])
  })
})
