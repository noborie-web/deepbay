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

export function summarizeInventoryActionRun(results: InventoryActionOutcome[]): {
  status: 'completed' | 'failed'
  errorMessage: string | null
} {
  const failed = results.filter(result => !result.success)
  if (failed.length === 0) return { status: 'completed', errorMessage: null }

  const details = failed
    .map(result => result.error)
    .filter((error): error is string => Boolean(error))
    .slice(0, 3)
    .join(' / ')

  return {
    status: 'failed',
    errorMessage: `${failed.length}/${results.length}件失敗${details ? `: ${details}` : ''}`,
  }
}
