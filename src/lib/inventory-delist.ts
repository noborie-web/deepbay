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

export interface DelistAgeSettings {
  days_until_delist?: unknown
  delist_by_age_enabled?: unknown
}

// ユーザー要望: 「N日経過取り下げ」をON/OFFできるようにする。
// OFFのときは経過日数による取り下げを行わない(取り下げ対象は0件、
// 自動取り下げも実行しない)。未設定(undefined/null)は従来の挙動を
// 保つためONとみなす。
export function isDelistByAgeEnabled(settings: DelistAgeSettings | null | undefined): boolean {
  return settings?.delist_by_age_enabled !== false
}
