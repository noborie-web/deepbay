import { describe, it, expect } from 'vitest'
import { shouldUseBulkRefresh } from '@/lib/inventory-sync'
import { allocateSyncBudgets } from '@/lib/inventory-sync-budget'

describe('一覧取得(GetMyeBaySelling)を使うかの判定', () => {
  // 本番で確認した不具合(2026-10-22): akebono-32 の出品が300件を超えて
  // 「一覧取得する」側に切り替わったが、取得予算は比例配分の下限15秒に
  // 張り付いていた。毎回15秒で時間切れ → 残り5秒未満で個別照会も走らず、
  // 1件も取得できないまま4回/日×3日間、479件が更新停止した。
  it('予算が足りないセラーでは一覧取得を使わない(個別照会に任せる)', () => {
    expect(shouldUseBulkRefresh(350, { bulkRefresh: true, fetchTotalTimeoutMs: 15_000 })).toBe(false)
  })

  it('予算が足りるセラーでは従来どおり一覧取得を使う', () => {
    expect(shouldUseBulkRefresh(350, { bulkRefresh: true, fetchTotalTimeoutMs: 69_751 })).toBe(true)
  })

  it('300件未満は予算が足りても個別照会(他ツールの出品まで落とすと遅い)', () => {
    expect(shouldUseBulkRefresh(128, { bulkRefresh: true, fetchTotalTimeoutMs: 80_000 })).toBe(false)
  })

  it('0件のセラーは発見のため一覧取得を使う', () => {
    expect(shouldUseBulkRefresh(0, { bulkRefresh: true, fetchTotalTimeoutMs: 80_000 })).toBe(true)
  })

  it('bulkRefreshが有効でなければ使わない', () => {
    expect(shouldUseBulkRefresh(350, { fetchTotalTimeoutMs: 80_000 })).toBe(false)
  })

  it('予算の指定が無ければ件数だけで決める(手動同期)', () => {
    expect(shouldUseBulkRefresh(350, { bulkRefresh: true })).toBe(true)
  })

  // 15秒の下限ちょうどで壊れていたので、境界を明示しておく
  it('30秒が境界', () => {
    expect(shouldUseBulkRefresh(350, { bulkRefresh: true, fetchTotalTimeoutMs: 29_999 })).toBe(false)
    expect(shouldUseBulkRefresh(350, { bulkRefresh: true, fetchTotalTimeoutMs: 30_000 })).toBe(true)
  })
})

describe('本番の配分でも両方のセラーが一覧取得を使えること', () => {
  // 本番で起きた事故(2026-10-24): eBayの1日の上限(5,000回)を超えた。
  // 原因は akebono-32 が cron 4回・手動9回のすべてで一覧取得を使えず、
  // 全件を個別照会(GetItem)していたこと。予算が比例配分の下限15秒に
  // 張り付き、一覧取得のガード(30秒)に毎回掛かっていた。
  // 一覧取得は1回200件なので、使えないと呼び出し回数が桁違いに増える。
  const AKEBONO = 546
  const MIYABI = 2966

  it('件数の少ないセラーにも一覧取得が終わる予算を与える', () => {
    const [akebono, miyabi] = allocateSyncBudgets([AKEBONO, MIYABI], { maxItems: 800, fetchMs: 80_000 })
    expect(akebono.fetchTotalTimeoutMs).toBeGreaterThanOrEqual(30_000)
    expect(shouldUseBulkRefresh(AKEBONO, { bulkRefresh: true, fetchTotalTimeoutMs: akebono.fetchTotalTimeoutMs })).toBe(true)
    expect(shouldUseBulkRefresh(MIYABI, { bulkRefresh: true, fetchTotalTimeoutMs: miyabi.fetchTotalTimeoutMs })).toBe(true)
  })

  it('下限の合計が予算を超えない(セラーが増えても破綻しない)', () => {
    const budgets = allocateSyncBudgets([100, 100, 100, 100], { maxItems: 800, fetchMs: 80_000 })
    const total = budgets.reduce((sum, b) => sum + b.fetchTotalTimeoutMs, 0)
    expect(total).toBeLessThanOrEqual(80_000)
  })
})

describe('手動同期も一覧取得を使えること', () => {
  // 本番で起きた事故(2026-10-24): 手動同期は取得予算が22秒で、一覧取得の
  // ガード(30秒)に毎回掛かっていた。akebono-32 の手動9回はすべて個別照会。
  it('取得予算が一覧取得の必要時間を上回る', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync('src/app/api/inventory/sync/route.ts', 'utf8')
    const budget = Number(src.match(/const FETCH_BUDGET_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''))
    expect(budget).toBeGreaterThanOrEqual(30_000)
    expect(shouldUseBulkRefresh(2966, { bulkRefresh: true, fetchTotalTimeoutMs: budget })).toBe(true)
  })

  it('取得予算はルートの打ち切りより短い(先に打ち切られない)', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync('src/app/api/inventory/sync/route.ts', 'utf8')
    const budget = Number(src.match(/const FETCH_BUDGET_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''))
    const routeTimeout = Number(src.match(/const ROUTE_TIMEOUT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, ''))
    const maxDuration = Number(src.match(/export const maxDuration = (\d+)/)?.[1])
    expect(budget).toBeLessThan(routeTimeout)
    expect(routeTimeout).toBeLessThan(maxDuration * 1000)
  })
})
