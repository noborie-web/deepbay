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

describe('本番の配分で akebono-32 が一覧取得に入らないこと', () => {
  // 2026-10-22時点の実数。akebono-32 は比例配分だと10.2秒で、下限の15秒に
  // 張り付く。この組み合わせが3日間の更新停止を起こしたので、配分と判定を
  // つないだ形で固定する。
  const AKEBONO = 350
  const MIYABI = 2382

  it('akebono-32の予算は下限の15秒で、一覧取得には足りない', () => {
    const [akebono, miyabi] = allocateSyncBudgets([AKEBONO, MIYABI], { maxItems: 800, fetchMs: 80_000 })
    expect(akebono.fetchTotalTimeoutMs).toBe(15_000)
    expect(shouldUseBulkRefresh(AKEBONO, { bulkRefresh: true, fetchTotalTimeoutMs: akebono.fetchTotalTimeoutMs })).toBe(false)
    // 件数の多いmiyabi-24は従来どおり一覧取得で回る
    expect(shouldUseBulkRefresh(MIYABI, { bulkRefresh: true, fetchTotalTimeoutMs: miyabi.fetchTotalTimeoutMs })).toBe(true)
  })
})
