const DEFAULT_DAYS_UNTIL_DELIST = 29
const MIN_DAYS_UNTIL_DELIST = 1
const MAX_DAYS_UNTIL_DELIST = 365

export function normalizeDaysUntilDelist(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DAYS_UNTIL_DELIST
  return Math.min(MAX_DAYS_UNTIL_DELIST, Math.max(MIN_DAYS_UNTIL_DELIST, Math.floor(value)))
}

export function getDelistCutoffIso(daysUntilDelist: unknown, now = new Date()): string {
  const days = normalizeDaysUntilDelist(daysUntilDelist)
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}
