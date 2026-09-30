import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { flushEbayCallCounts, pacificDate, recordEbayCall, takeEbayCallCounts } from '@/lib/ebay-call-counter'

// ユーザー要望(2026-09-30): APIの容量と消費が見えるようにしたい。
// eBayの GetApiAccessRules は廃止(HTTP 410)のため、送った回数を自分で数える。
describe('eBay呼び出し回数の記録', () => {
  beforeEach(() => { takeEbayCallCounts() })

  it('呼び出しごとに回数を数える', () => {
    recordEbayCall('GetItem')
    recordEbayCall('GetItem')
    recordEbayCall('ReviseInventoryStatus')
    expect(takeEbayCallCounts().sort((a, b) => a.callName.localeCompare(b.callName))).toEqual([
      { callName: 'GetItem', count: 2 },
      { callName: 'ReviseInventoryStatus', count: 1 },
    ])
  })

  it('取り出すと空になる(二重に記録しない)', () => {
    recordEbayCall('GetItem')
    takeEbayCallCounts()
    expect(takeEbayCallCounts()).toEqual([])
  })

  it('太平洋時間の日付で集計する(日本時間の16時台に切り替わる)', () => {
    // 日本時間 2026-10-01 00:00 = 太平洋時間 2026-09-30
    expect(pacificDate(new Date('2026-09-30T15:00:00Z'))).toBe('2026-09-30')
    // 日本時間 2026-10-01 16:30 = 太平洋時間 2026-10-01
    expect(pacificDate(new Date('2026-10-01T07:30:00Z'))).toBe('2026-10-01')
  })

  it('記録に失敗しても例外を投げない(本来の処理を止めない)', async () => {
    recordEbayCall('GetItem')
    const db = { from: () => ({ insert: async () => ({ error: { message: 'boom' } }) }) } as unknown as SupabaseClient
    await expect(flushEbayCallCounts(db, 'user-1')).resolves.toBeUndefined()
  })

  it('貯めた回数をまとめて記録する', async () => {
    recordEbayCall('GetMyeBaySelling', 51)
    const inserted: unknown[] = []
    const db = {
      from: () => ({ insert: async (rows: unknown) => { inserted.push(rows); return { error: null } } }),
    } as unknown as SupabaseClient
    await flushEbayCallCounts(db, 'user-1', new Date('2026-09-30T15:00:00Z'))
    expect(inserted[0]).toEqual([
      { user_id: 'user-1', called_on: '2026-09-30', call_name: 'GetMyeBaySelling', count: 51 },
    ])
  })
})
