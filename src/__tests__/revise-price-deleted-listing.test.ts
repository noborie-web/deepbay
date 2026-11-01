import { describe, it, expect, vi, beforeEach } from 'vitest'

// 本番で確認した問題(2026-11-01): eBay上に無い出品(900012836561)が在庫一覧に
// 残っていたため、価格改定が4回/日すべてこの1件で失敗し続けていた。次回の同期を
// 待っても、照会対象に入っていなければ外れない。
// ただしeBayのエラー文は「削除済み」と「あなたがセラーではない」を兼ねているので、
// これだけで消すとセラーの割り当てが違うだけの生きた出品を失う。
// GetItemで存在しないことを確かめてから外す。

const DELETED_ERROR = 'This item cannot be accessed because the listing has been deleted or you are not the seller.'

const mocks = vi.hoisted(() => ({
  reviseBatch: vi.fn(),
  fetchByItemIds: vi.fn(),
  dropEnded: vi.fn(),
}))

vi.mock('@/lib/ebay-actions', () => ({ reviseInventoryStatusBatch: mocks.reviseBatch }))
vi.mock('@/lib/ebay-inventory', () => ({ fetchListingsByItemIds: mocks.fetchByItemIds }))
vi.mock('@/lib/inventory-sync', () => ({
  applyRevisedPrices: vi.fn(async () => {}),
  dropEndedListings: mocks.dropEnded,
}))
vi.mock('@/lib/inventory-token-resolver', () => ({
  createInventoryTokenResolver: vi.fn(async () => ({
    accounts: [], tokenFor: () => 'token', defaultToken: 'token', authErrors: [],
  })),
}))
vi.mock('@/lib/inventory-pricing', () => ({
  loadPricingModel: vi.fn(async () => null),
  adjustedJpyRate: (_m: unknown, _c: string, rate: number) => rate,
  sitePriceAdjustment: () => 1,
}))
vi.mock('@/lib/inventory-site-pricing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inventory-site-pricing')>()),
  loadJpyRates: vi.fn(async () => new Map([['USD', 150]])),
}))
vi.mock('@/lib/ebay-call-counter', () => ({
  EBAY_RESERVED_CALLS: 0,
  remainingEbayCalls: vi.fn(async () => 1000),
}))

import { runRevisePriceForUser } from '@/lib/inventory-revise-price'

// 出品の読み出しは selectAllRows / selectByIds を差し替える。
// 現在$100・目標$99 なら、15%超の値下げガードに掛からず必ず送信対象になる。
vi.mock('@/lib/db-chunk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db-chunk')>()),
  selectByIds: vi.fn(async () => [{ id: 'p1', ebay_price: 99, pricing_jpy_per_usd: 150 }]),
  selectAllRows: vi.fn(async () => [{
    ebay_item_id: '900012836561', product_id: 'p1', current_price: 100,
    site_id: 'US', currency: 'USD', seller_account_id: 'seller-a', quantity: 1,
  }]),
}))

// 上の差し替えで出品は読めるので、ここは繋がるだけでよい
function db() {
  return {
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'is', 'or', 'order', 'in', 'limit']) {
        chain[m] = vi.fn(() => chain)
      }
      chain.range = vi.fn(async () => ({ data: [], error: null }))
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      return chain
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  mocks.reviseBatch.mockReset().mockResolvedValue({
    results: [{ itemId: '900012836561', success: false, error: DELETED_ERROR }], deferred: 0,
  })
  mocks.fetchByItemIds.mockReset()
  mocks.dropEnded.mockReset().mockResolvedValue(undefined)
})

describe('「出品が削除済み」で失敗した出品', () => {
  it('eBayに存在しないと確認できたら在庫一覧から外す', async () => {
    mocks.fetchByItemIds.mockResolvedValue({
      items: [], endedItemIds: ['900012836561'],
      endedListings: [{ ebayItemId: '900012836561', quantitySold: null, listingStatus: null, endTime: null }],
    })

    const { summary } = await runRevisePriceForUser(db(), 'u1', {})

    // 消す前に必ずGetItemで確かめる
    expect(mocks.fetchByItemIds).toHaveBeenCalledTimes(1)
    expect(mocks.fetchByItemIds.mock.calls[0][1]).toEqual(['900012836561'])
    expect(mocks.dropEnded).toHaveBeenCalledTimes(1)
    expect(mocks.dropEnded.mock.calls[0][2]).toEqual(['900012836561'])
    expect(summary.dropped_deleted).toBe(1)
  })

  it('eBayに存在していたら消さない(セラーの割り当て違いを消さない)', async () => {
    mocks.fetchByItemIds.mockResolvedValue({
      items: [{ ebayItemId: '900012836561', quantity: 1, quantitySold: 0, listingStatus: 'Active' }],
      endedItemIds: [], endedListings: [],
    })

    const { summary } = await runRevisePriceForUser(db(), 'u1', {})

    expect(mocks.fetchByItemIds).toHaveBeenCalledTimes(1)
    // ここが本題。生きている出品を消すと在庫管理から落ちる
    expect(mocks.dropEnded).not.toHaveBeenCalled()
    expect(summary.dropped_deleted).toBe(0)
  })

  it('確認に失敗しても価格改定の結果は返す', async () => {
    mocks.fetchByItemIds.mockRejectedValue(new Error('eBay API HTTP error: 500'))

    const { summary } = await runRevisePriceForUser(db(), 'u1', {})

    expect(mocks.dropEnded).not.toHaveBeenCalled()
    expect(summary.total).toBe(1)
    expect(summary.dropped_deleted).toBe(0)
  })

  it('削除済み以外の失敗ではGetItemを呼ばない', async () => {
    mocks.reviseBatch.mockResolvedValue({
      results: [{ itemId: '900012836561', success: false, error: 'eBay API HTTP error: 500' }], deferred: 0,
    })

    await runRevisePriceForUser(db(), 'u1', {})

    expect(mocks.fetchByItemIds).not.toHaveBeenCalled()
    expect(mocks.dropEnded).not.toHaveBeenCalled()
  })
})
