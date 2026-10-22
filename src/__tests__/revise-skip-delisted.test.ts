import { describe, it, expect } from 'vitest'
import { onlyLiveListings } from '@/lib/inventory-listing-filter'

function recorder() {
  const calls: Array<[string, ...unknown[]]> = []
  const q: Record<string, unknown> = {}
  for (const name of ['is', 'or', 'eq', 'not', 'in', 'order']) {
    q[name] = (...args: unknown[]) => { calls.push([name, ...args]); return q }
  }
  return { q, calls }
}

describe('価格改定の対象は生きている出品だけ', () => {
  it('取り下げ済み(delisted_at)を除外する', () => {
    const { q, calls } = recorder()
    onlyLiveListings(q)
    expect(calls).toContainEqual(['is', 'delisted_at', null])
  })

  it('在庫0を除外し、在庫数が不明(null)の出品は残す', () => {
    const { q, calls } = recorder()
    onlyLiveListings(q)
    // PostgreSQLでは null > 0 が真にならないため、.gt('quantity', 0) だけだと
    // 「在庫数を取得できなかった出品」まで落ちる。実績のある取りこぼしなので
    // null を明示的に含める形を固定する。
    expect(calls).toContainEqual(['or', 'quantity.gt.0,quantity.is.null'])
    expect(calls.some(c => c[0] === 'gt')).toBe(false)
  })

  it('クエリをそのまま返すので連結できる', () => {
    const { q } = recorder()
    expect(onlyLiveListings(q)).toBe(q)
  })
})
