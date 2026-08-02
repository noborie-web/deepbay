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

export interface ExtractionResultSummaryRow {
  key: string
  label: string
  count: number
}

function countReasons(products: ExcludedProduct[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const product of products) {
    counts.set(product.reason_code, (counts.get(product.reason_code) ?? 0) + 1)
  }
  return counts
}

/**
 * 現在の商品と保存済みの除外スナップショットから、旧画面と同じ順番の
 * 抽出結果集計を組み立てる。機能追加前の除外は復元できないため、
 * 保存済みデータの範囲で集計する。
 */
export function buildExtractionResultSummary(
  currentProductCount: number,
  excludedProducts: ExcludedProduct[],
): ExtractionResultSummaryRow[] {
  const counts = countReasons(excludedProducts)
  const count = (...codes: string[]) => codes.reduce(
    (sum, code) => sum + (counts.get(code) ?? 0),
    0,
  )
  const displayedReasonCodes = new Set([
    'title_duplicate',
    'active_duplicate',
    'count_adjustment',
    'detail_failed',
    'sold_out',
    'missing_price',
    'price_missing',
    'initial_danger_seller',
    'danger_word',
    'no_image',
    'translation_failed',
    'translated_title_duplicate',
    'bulk_sold_out',
    'danger_seller',
    'shipping_days',
    'low_seller_rating',
    'seller_rating',
    'updated_at',
    'price_range',
  ])
  const otherExcluded = excludedProducts.filter(
    (product) => !displayedReasonCodes.has(product.reason_code),
  ).length

  const initialCount = Math.max(0, currentProductCount) + excludedProducts.length
  const titleDuplicate = count('title_duplicate')
  const activeDuplicate = count('active_duplicate')
  const countAdjustment = count('count_adjustment')
  const detailCount = Math.max(
    0,
    initialCount - titleDuplicate - activeDuplicate - countAdjustment,
  )

  return [
    { key: 'initial_count', label: '初回取得件数', count: initialCount },
    { key: 'title_duplicate', label: 'タイトル重複除外', count: titleDuplicate },
    { key: 'active_duplicate', label: 'active重複除外', count: activeDuplicate },
    { key: 'count_adjustment', label: '件数調整除外', count: countAdjustment },
    { key: 'detail_count', label: '詳細取得件数', count: detailCount },
    { key: 'detail_failed', label: '詳細取得失敗除外', count: count('detail_failed') },
    { key: 'sold_out', label: '売り切れ除外', count: count('sold_out') },
    {
      key: 'missing_price',
      label: '販売価格が取得できない除外',
      count: count('missing_price', 'price_missing'),
    },
    {
      key: 'initial_danger_seller',
      label: '個別危険Seller除外',
      count: count('initial_danger_seller'),
    },
    {
      key: 'danger_word',
      label: '危険単語除外',
      count: count('danger_word'),
    },
    { key: 'no_image', label: '画像が1枚もない除外', count: count('no_image') },
    {
      key: 'translation_failed',
      label: 'タイトル翻訳失敗除外',
      count: count('translation_failed'),
    },
    {
      key: 'translated_title_duplicate',
      label: '翻訳後タイトル重複除外',
      count: count('translated_title_duplicate'),
    },
    {
      key: 'bulk_sold_out',
      label: '（一括編集）売り切れ除外',
      count: count('bulk_sold_out'),
    },
    {
      key: 'bulk_danger_seller',
      label: '（一括編集）危険Seller除外',
      count: count('danger_seller'),
    },
    {
      key: 'shipping_days',
      label: '（一括編集）発送日数除外',
      count: count('shipping_days'),
    },
    {
      key: 'low_seller_rating',
      label: '（一括編集）低評価数除外',
      count: count('low_seller_rating'),
    },
    {
      key: 'seller_rating',
      label: '（一括編集）評価数除外',
      count: count('seller_rating'),
    },
    {
      key: 'updated_at',
      label: '（一括編集）最終更新月除外',
      count: count('updated_at'),
    },
    {
      key: 'price_range',
      label: '（一括編集）価格範囲除外',
      count: count('price_range'),
    },
    { key: 'other_excluded', label: 'その他の除外', count: otherExcluded },
    { key: 'excluded_total', label: '除外合計', count: excludedProducts.length },
    { key: 'completed_count', label: '取得完了件数', count: Math.max(0, currentProductCount) },
  ]
}
