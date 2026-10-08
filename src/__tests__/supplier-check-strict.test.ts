import { beforeEach, describe, expect, it, vi } from 'vitest'

// ユーザー要望(2026-10-08): 在庫切れを厳格にチェックしたい。
// 429やネットワーク障害で仕入先を確認できない状態が続くと、在庫が無いまま
// 出品され続けて売れてしまう。一定時間確認できなければ取り下げ対象にする。
const mocks = vi.hoisted(() => ({
  scrapeUrl: vi.fn(),
  findScraper: vi.fn(() => ({ siteKey: 'mercari' })),
  fetchUsdJpyRate: vi.fn(),
}))

vi.mock('@/lib/scrapers', () => ({ scrapeUrl: mocks.scrapeUrl, findScraper: mocks.findScraper }))
vi.mock('@/lib/exchange-rate', () => ({ fetchUsdJpyRate: mocks.fetchUsdJpyRate }))

import { checkSupplierListings } from '@/lib/inventory-supplier-check'

const HOUR = 60 * 60 * 1000

function makeDatabase(listing: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = []
  const product = {
    id: 'p1', source_url: 'https://jp.mercari.com/item/m1', source_site: 'mercari',
    original_title: 'タイトル', original_price: 5000, purchase_price_jpy: 5000,
    ebay_price: 50, pricing_jpy_per_usd: 150, extraction_id: null,
  }
  const db = {
    from(table: string) {
      const state = { update: null as Record<string, unknown> | null }
      const query = {
        select() { return query },
        eq() { return query },
        not() { return query },
        gt() { return query },
        or() { return query },
        in() { return query },
        order() { return query },
        limit() { return query },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        update(payload: Record<string, unknown>) {
          state.update = payload
          if (table === 'inventory_active_listings') updates.push(payload)
          return query
        },
        then(resolve: (value: unknown) => unknown) {
          if (state.update) return Promise.resolve({ data: null, error: null }).then(resolve)
          if (table === 'inventory_active_listings') return Promise.resolve({ data: [listing], error: null }).then(resolve)
          if (table === 'products') return Promise.resolve({ data: [product], error: null }).then(resolve)
          return Promise.resolve({ data: [], error: null }).then(resolve)
        },
      }
      return query
    },
  }
  return { db, updates }
}

describe('仕入先を確認できない出品の厳格な取り扱い', () => {
  beforeEach(() => {
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150 })
    mocks.findScraper.mockReturnValue({ siteKey: 'mercari' })
    // 常に429で確認できない状態にする
    mocks.scrapeUrl.mockReset().mockRejectedValue(new Error('HTTP 429 Too Many Requests'))
  })

  it('確認できた最後の時刻から24時間を超えていれば在庫0にする', async () => {
    const { db, updates } = makeDatabase({
      id: 'l1', product_id: 'p1', ebay_item_id: '1',
      supplier_verified_at: new Date(Date.now() - 25 * HOUR).toISOString(),
    })

    const result = await checkSupplierListings(db as never, 'user-1', 10, {
      delistOnUnverified: true,
      unverifiedDelistHours: 24,
    })

    expect(result.unverified_delisted).toBe(1)
    expect(result.unavailable).toBe(1)
    expect(updates[0].quantity).toBe(0)
  })

  it('24時間以内なら取り下げず、次回に回す', async () => {
    const { db, updates } = makeDatabase({
      id: 'l1', product_id: 'p1', ebay_item_id: '1',
      supplier_verified_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    })

    const result = await checkSupplierListings(db as never, 'user-1', 10, {
      delistOnUnverified: true,
      unverifiedDelistHours: 24,
    })

    expect(result.unverified_delisted).toBe(0)
    expect(updates.some((u) => u.quantity === 0)).toBe(false)
  })

  it('設定がOFFなら、何日確認できていなくても取り下げない（従来動作）', async () => {
    const { db, updates } = makeDatabase({
      id: 'l1', product_id: 'p1', ebay_item_id: '1',
      supplier_verified_at: new Date(Date.now() - 30 * 24 * HOUR).toISOString(),
    })

    const result = await checkSupplierListings(db as never, 'user-1', 10, {
      delistOnUnverified: false,
    })

    expect(result.unverified_delisted).toBe(0)
    expect(updates.some((u) => u.quantity === 0)).toBe(false)
  })

  it('確認できた日時が無ければ取り下げない（導入直後に全件を止めない）', async () => {
    const { db, updates } = makeDatabase({
      id: 'l1', product_id: 'p1', ebay_item_id: '1',
      supplier_verified_at: null, supplier_checked_at: null, fetched_at: null,
    })

    const result = await checkSupplierListings(db as never, 'user-1', 10, {
      delistOnUnverified: true,
      unverifiedDelistHours: 24,
    })

    expect(result.unverified_delisted).toBe(0)
    expect(updates.some((u) => u.quantity === 0)).toBe(false)
  })
})

describe('確認できた日時(supplier_verified_at)の記録', () => {
  beforeEach(() => {
    mocks.fetchUsdJpyRate.mockReset().mockResolvedValue({ rate: 150 })
    mocks.findScraper.mockReturnValue({ siteKey: 'mercari' })
  })

  it('在庫を確認できた回だけ更新する', async () => {
    mocks.scrapeUrl.mockReset().mockResolvedValue([{ availability: 'available', price: 5000, title: 'タイトル' }])
    const { db, updates } = makeDatabase({ id: 'l1', product_id: 'p1', ebay_item_id: '1', supplier_verified_at: null })

    await checkSupplierListings(db as never, 'user-1', 10, {})

    expect(updates[0].supplier_verified_at).toBeTruthy()
  })

  it('通信エラーで中身を見られなかった回は更新しない', async () => {
    mocks.scrapeUrl.mockReset().mockRejectedValue(new Error('network error'))
    const { db, updates } = makeDatabase({
      id: 'l1', product_id: 'p1', ebay_item_id: '1',
      supplier_verified_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    })

    await checkSupplierListings(db as never, 'user-1', 10, {})

    expect(updates[0].supplier_verified_at).toBeUndefined()
    // 確認を試みたこと自体は記録する
    expect(updates[0].supplier_checked_at).toBeTruthy()
  })
})
