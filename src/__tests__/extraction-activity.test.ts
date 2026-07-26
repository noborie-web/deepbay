import { describe, expect, it } from 'vitest'
import {
  activityBadges,
  latestActivitiesByType,
  latestActivityAt,
  summarizeExclusions,
} from '@/lib/extraction-activity'
import type { ExcludedProduct, ExtractionActivity } from '@/types/database'

function activity(
  activityType: ExtractionActivity['activity_type'],
  createdAt: string,
  itemCount = 1,
): ExtractionActivity {
  return {
    id: `${activityType}-${createdAt}`,
    extraction_id: 'ext-1',
    user_id: 'user-1',
    activity_type: activityType,
    label: activityType,
    item_count: itemCount,
    metadata: {},
    created_at: createdAt,
  }
}

function excluded(reasonCode: string, reasonLabel: string, id: string): ExcludedProduct {
  return {
    id,
    extraction_id: 'ext-1',
    user_id: 'user-1',
    product_id: `product-${id}`,
    reason_code: reasonCode,
    reason_label: reasonLabel,
    source_url: `https://example.com/${id}`,
    original_title: `商品 ${id}`,
    original_price: 1000,
    image_url: null,
    metadata: {},
    excluded_at: '2026-07-26T09:00:00.000Z',
  }
}

describe('extraction activity helpers', () => {
  it('種類ごとに最新の履歴を選び、編集・出力日時を返す', () => {
    const activities = [
      activity('edited', '2026-07-25T00:00:00.000Z'),
      activity('edited', '2026-07-26T00:00:00.000Z'),
      activity('csv_exported', '2026-07-26T01:00:00.000Z'),
    ]

    expect(latestActivitiesByType(activities).get('edited')?.created_at)
      .toBe('2026-07-26T00:00:00.000Z')
    expect(latestActivityAt(activities, ['edited'])).toBe('2026-07-26T00:00:00.000Z')
    expect(latestActivityAt(activities, ['csv_exported', 'direct_listed']))
      .toBe('2026-07-26T01:00:00.000Z')
  })

  it('一覧用バッジを固定順で作り、複数回の除外件数を合算する', () => {
    const badges = activityBadges([
      activity('excluded', '2026-07-26T03:00:00.000Z', 2),
      activity('edited', '2026-07-26T00:00:00.000Z', 4),
      activity('csv_exported', '2026-07-26T01:00:00.000Z', 4),
      activity('excluded', '2026-07-26T02:00:00.000Z', 3),
    ])

    expect(badges.map((badge) => badge.label)).toEqual([
      '編集済み',
      'CSV出力済み',
      '除外済み 5件',
    ])
    expect(badges.at(-1)?.count).toBe(5)
  })

  it('除外理由ごとの件数を多い順で集計する', () => {
    expect(summarizeExclusions([
      excluded('sold_out', '売り切れ', '1'),
      excluded('danger_seller', '危険セラー', '2'),
      excluded('sold_out', '売り切れ', '3'),
    ])).toEqual([
      { reasonCode: 'sold_out', reasonLabel: '売り切れ', count: 2 },
      { reasonCode: 'danger_seller', reasonLabel: '危険セラー', count: 1 },
    ])
  })
})
