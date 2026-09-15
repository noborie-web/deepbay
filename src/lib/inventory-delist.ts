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

export interface DelistSettings extends DelistAgeSettings {
  delist_on_sold_out?: unknown
}

export interface DelistEligibility {
  // 取り下げが有効か(false なら手動・自動とも対象0件)
  enabled: boolean
  // 即取り下げモード(売り切れ=在庫0だけを条件にする)
  immediate: boolean
  // 経過日数モードのときの出品開始日時の上限(ISO)。即取り下げでは null
  cutoffIso: string | null
}

// ユーザー要望: 「仕入先が売り切れたら即取り下げ(N日経過を待たない)」。
// delist_on_sold_out がONなら在庫0だけを条件にし、OFFなら従来どおり
// 「在庫0 かつ N日経過」(N日経過取り下げがOFFなら取り下げなし)。
export function resolveDelistEligibility(
  settings: DelistSettings | null | undefined,
  now = new Date(),
): DelistEligibility {
  if (settings?.delist_on_sold_out === true) {
    return { enabled: true, immediate: true, cutoffIso: null }
  }
  if (!isDelistByAgeEnabled(settings)) {
    return { enabled: false, immediate: false, cutoffIso: null }
  }
  return { enabled: true, immediate: false, cutoffIso: getDelistCutoffIso(settings?.days_until_delist, now) }
}
