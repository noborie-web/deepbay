import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ calls: [] as Array<[string, ...unknown[]]> }))

vi.mock('@/lib/ebay-actions', () => ({
  reviseInventoryStatusBatch: vi.fn(async () => ({ results: [], deferred: 0 })),
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
vi.mock('@/lib/inventory-sync', () => ({ applyRevisedPrices: vi.fn(async () => {}) }))

import { runRevisePriceForUser } from '@/lib/inventory-revise-price'

function db() {
  return {
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'is', 'or', 'order', 'in', 'limit']) {
        chain[m] = vi.fn((...args: unknown[]) => { mocks.calls.push([m, ...args]); return chain })
      }
      chain.range = vi.fn(async () => ({ data: [], error: null }))
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      return chain
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('価格改定の対象', () => {
  // 本番で確認した無駄(2026-10-22): 絞り込みが無く、既に取り下げた373件にも
  // Reviseを送っていた。時間予算を食って本来直すべき出品が持ち越される。
  it('取り下げ済み・在庫0を除いた生きている出品だけを引く', async () => {
    mocks.calls.length = 0
    await runRevisePriceForUser(db(), 'u1', {})
    expect(mocks.calls).toContainEqual(['is', 'delisted_at', null])
    // 在庫数が不明(null)の出品はeBayに生きているので残す
    expect(mocks.calls).toContainEqual(['or', 'quantity.gt.0,quantity.is.null'])
    // 商品に紐付かない出品(他ツールの出品)は触らない
    expect(mocks.calls).toContainEqual(['not', 'product_id', 'is', null])
  })

  it('1,000行の上限を避けてページ送りする', async () => {
    mocks.calls.length = 0
    await runRevisePriceForUser(db(), 'u1', {})
    expect(mocks.calls.some(c => c[0] === 'order')).toBe(true)
  })
})
