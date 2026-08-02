import { describe, expect, it } from 'vitest'
import {
  activityBadges,
  latestActivitiesByType,
  latestActivityAt,
  buildExtractionResultSummary,
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

function excluded(
  reasonCode: string,
  reasonLabel: string,
  id: string,
  metadata: Record<string, unknown> = {},
): ExcludedProduct {
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
    metadata,
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

  it('現在の商品と除外履歴から旧画面順の抽出結果集計を作る', () => {
    const rows = buildExtractionResultSummary(120, [
      excluded('title_duplicate', 'タイトル重複', '1'),
      excluded('title_duplicate', 'タイトル重複', '2'),
      excluded('shipping_days', '発送日数', '3'),
      excluded('seller_rating', '評価数', '4'),
      excluded('updated_at', '最終更新月', '5'),
    ])
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.count]))

    expect(rows[0].label).toBe('初回取得件数')
    expect(byKey.initial_count).toBe(125)
    expect(byKey.title_duplicate).toBe(2)
    expect(byKey.detail_count).toBe(123)
    expect(byKey.shipping_days).toBe(1)
    expect(byKey.seller_rating).toBe(1)
    expect(byKey.updated_at).toBe(1)
    expect(byKey.excluded_total).toBe(5)
    expect(byKey.completed_count).toBe(120)
  })

  it('危険単語と未知の理由も除外合計から漏らさず表示する', () => {
    const rows = buildExtractionResultSummary(591, [
      ...Array.from({ length: 9 }, (_, index) => (
        excluded('danger_word', '危険単語', String(index))
      )),
      excluded('future_reason', '将来追加された理由', 'future'),
    ])
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.count]))

    expect(byKey.initial_count).toBe(601)
    expect(byKey.danger_word).toBe(9)
    expect(byKey.other_excluded).toBe(1)
    expect(byKey.excluded_total).toBe(10)
    expect(byKey.completed_count).toBe(591)
  })

  it('件数が負にならない', () => {
    const rows = buildExtractionResultSummary(-1, [])
    expect(rows.find((row) => row.key === 'initial_count')?.count).toBe(0)
    expect(rows.find((row) => row.key === 'completed_count')?.count).toBe(0)
  })
})
