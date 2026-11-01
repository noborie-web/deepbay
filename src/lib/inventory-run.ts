import type { SupabaseClient } from '@supabase/supabase-js'

export const INVENTORY_SYNC_STALE_AFTER_MS = 2 * 60_000
export const INVENTORY_SYNC_STALE_MESSAGE = '同期処理がタイムアウトしたため終了しました'

export async function expireStaleInventorySyncRuns(
  db: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - INVENTORY_SYNC_STALE_AFTER_MS).toISOString()
  const { error } = await db
    .from('inventory_runs')
    .update({
      status: 'failed',
      error_message: INVENTORY_SYNC_STALE_MESSAGE,
      finished_at: now.toISOString(),
    })
    .eq('user_id', userId)
    .eq('run_type', 'sync')
    .eq('status', 'running')
    .lt('started_at', cutoff)

  if (error) throw new Error(`Failed to expire stale inventory sync runs: ${error.message}`)
}

export interface InventoryActionOutcome {
  success: boolean
  error?: string
}

// eBay側の事情で、再試行しても直らない出品ごとの失敗。
//
// 本番で確認した問題(2026-11-01): 価格改定は9回すべて status:'failed' だったが、
// 実際は毎回 95%以上成功しており、失敗していたのは常に同じ5件だけだった。
//   377576258008 / 860052566591  LIVRE Light Arm 65 が重複出品
//   860052566611 / 860052566634  LIVRE Fairy 41 が重複出品
//   900012836561                 出品が削除済み
// どれもeBay側を直すまで解消しない。これで実行全体を失敗にすると、本当の失敗
// (トークン切れ・呼び出し上限・通信エラー)がこの5件に埋もれて気づけない。
const PERMANENT_ITEM_ERROR_PATTERNS = [
  // eBay上で同じ商品が2重に出品されている。片方を取り下げるまで直らない
  'item you already have on eBay',
  // 出品が削除済み(または別セラーのもの)。在庫一覧から外れるまで出続ける
  'listing has been deleted or you are not the seller',
]

export function isPermanentItemError(error: string | undefined | null): boolean {
  if (!error) return false
  return PERMANENT_ITEM_ERROR_PATTERNS.some(pattern => error.includes(pattern))
}

export function summarizeInventoryActionRun(results: InventoryActionOutcome[]): {
  status: 'completed' | 'failed'
  errorMessage: string | null
} {
  const failed = results.filter(result => !result.success)
  if (failed.length === 0) return { status: 'completed', errorMessage: null }

  const detailsOf = (list: InventoryActionOutcome[]): string => list
    .map(result => result.error)
    .filter((error): error is string => Boolean(error))
    .slice(0, 3)
    .join(' / ')

  // eBay側を直すまで解消しない失敗と、こちらで対処すべき失敗を分ける
  const permanent = failed.filter(result => isPermanentItemError(result.error))
  const actionable = failed.filter(result => !isPermanentItemError(result.error))

  // eBay側の事情だけなら、実行自体は成功している。ただし理由は必ず残して
  // 画面から見えるようにする(黙って成功にすると気づけなくなる)
  if (actionable.length === 0) {
    const details = detailsOf(permanent)
    return {
      status: 'completed',
      errorMessage: `${permanent.length}/${results.length}件はeBay側の事情でスキップ(再試行しても解消しません)${details ? `: ${details}` : ''}`,
    }
  }

  const details = detailsOf(actionable)
  const skipped = permanent.length > 0 ? `(ほかに${permanent.length}件はeBay側の事情でスキップ)` : ''
  return {
    status: 'failed',
    errorMessage: `${actionable.length}/${results.length}件失敗${skipped}${details ? `: ${details}` : ''}`,
  }
}
