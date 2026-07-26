import type {
  ExcludedProduct,
  ExtractionActivity,
  ExtractionActivityType,
} from '@/types/database'

export interface ActivityBadge {
  type: ExtractionActivityType
  label: string
  count: number
  createdAt: string
  variant: 'success' | 'warning' | 'info' | 'default'
}

const BADGE_CONFIG: Partial<Record<
  ExtractionActivityType,
  { label: string; variant: ActivityBadge['variant'] }
>> = {
  edited: { label: '編集済み', variant: 'success' },
  csv_exported: { label: 'CSV出力済み', variant: 'warning' },
  specifics_csv_exported: { label: '45列CSV出力済み', variant: 'info' },
  direct_listed: { label: '出品済み', variant: 'info' },
  excluded: { label: '除外済み', variant: 'default' },
}

export function latestActivitiesByType(
  activities: ExtractionActivity[] = [],
): Map<ExtractionActivityType, ExtractionActivity> {
  const latest = new Map<ExtractionActivityType, ExtractionActivity>()
  for (const activity of [...activities].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )) {
    if (!latest.has(activity.activity_type)) latest.set(activity.activity_type, activity)
  }
  return latest
}

export function activityBadges(activities: ExtractionActivity[] = []): ActivityBadge[] {
  const latest = latestActivitiesByType(activities)
  const excludedTotal = activities
    .filter((activity) => activity.activity_type === 'excluded')
    .reduce((sum, activity) => sum + activity.item_count, 0)
  const order: ExtractionActivityType[] = [
    'edited',
    'csv_exported',
    'specifics_csv_exported',
    'direct_listed',
    'excluded',
  ]
  return order.flatMap((type) => {
    const activity = latest.get(type)
    const config = BADGE_CONFIG[type]
    if (!activity || !config) return []
    return [{
      type,
      label: type === 'excluded' && excludedTotal > 0
        ? `${config.label} ${excludedTotal}件`
        : config.label,
      count: type === 'excluded' ? excludedTotal : activity.item_count,
      createdAt: activity.created_at,
      variant: config.variant,
    }]
  })
}

export function latestActivityAt(
  activities: ExtractionActivity[] = [],
  types: ExtractionActivityType[],
): string | null {
  const matches = activities
    .filter((activity) => types.includes(activity.activity_type))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  return matches[0]?.created_at ?? null
}

export interface ExclusionReasonSummary {
  reasonCode: string
  reasonLabel: string
  count: number
}

export function summarizeExclusions(products: ExcludedProduct[]): ExclusionReasonSummary[] {
  const grouped = new Map<string, ExclusionReasonSummary>()
  for (const product of products) {
    const current = grouped.get(product.reason_code)
    if (current) {
      current.count += 1
    } else {
      grouped.set(product.reason_code, {
        reasonCode: product.reason_code,
        reasonLabel: product.reason_label,
        count: 1,
      })
    }
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count)
}
