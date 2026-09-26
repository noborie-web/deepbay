// ---------------------------------------------------------------------------
// 同期の予算配分(セラーごと)
//
// 本番で確認した不具合(2026-09-26): 出品アカウントを2つにした初日、1回の実行を
// 単純に2等分したため miyabi-24 の照会上限が 800→400件 に下がり、695件を一巡
// するのに2回(半日)かかるようになった。akebono-32 は出品0件で予算を使わない
// ので、配分は「そのセラーが持っている出品件数」に比例させる。
// ---------------------------------------------------------------------------

export interface SyncBudget {
  maxItemsPerRun: number
  fetchTotalTimeoutMs: number
}

export interface SyncBudgetLimits {
  maxItems: number
  fetchMs: number
}

// 出品0件のセラーにも、新しく出品した分を取り込めるだけの最低限は残す
const MIN_ITEMS = 50
const MIN_FETCH_MS = 15_000

export function allocateSyncBudgets(counts: number[], limits: SyncBudgetLimits): SyncBudget[] {
  if (counts.length <= 1) {
    return counts.map(() => ({ maxItemsPerRun: limits.maxItems, fetchTotalTimeoutMs: limits.fetchMs }))
  }
  const total = counts.reduce((sum, count) => sum + Math.max(0, count), 0)
  if (total === 0) {
    // まだどのセラーにも出品が無い(初回)。均等に分ける。
    return counts.map(() => ({
      maxItemsPerRun: Math.max(MIN_ITEMS, Math.floor(limits.maxItems / counts.length)),
      fetchTotalTimeoutMs: Math.max(MIN_FETCH_MS, Math.floor(limits.fetchMs / counts.length)),
    }))
  }
  return counts.map(count => {
    const share = Math.max(0, count) / total
    return {
      maxItemsPerRun: Math.max(MIN_ITEMS, Math.round(limits.maxItems * share)),
      fetchTotalTimeoutMs: Math.max(MIN_FETCH_MS, Math.round(limits.fetchMs * share)),
    }
  })
}
