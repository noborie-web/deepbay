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
