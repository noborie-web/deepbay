import { describe, expect, it } from 'vitest'
import { isSlotActive, resolveRunSlot, shouldRevisePriceInSlot, slotsForRunCount } from '../lib/inventory-schedule'

// ユーザー要望: 在庫管理を1日最大4回(03/09/15/21 JST)実行し、価格改定は
// 「毎回 / 朝のみ」を選べるようにする。
describe('inventory-schedule', () => {
  it('稼働回数ごとの実行時間帯(朝9時は必ず含む)', () => {
    expect(slotsForRunCount(1)).toEqual([9])
    expect(slotsForRunCount(2)).toEqual([9, 21])
    expect(slotsForRunCount(3)).toEqual([9, 15, 21])
    expect(slotsForRunCount(4)).toEqual([3, 9, 15, 21])
    expect(slotsForRunCount(99)).toEqual([9])
    expect(isSlotActive(2, 15)).toBe(false)
    expect(isSlotActive(3, 15)).toBe(true)
  })

  it('価格改定は「朝のみ」なら9時の時間帯だけ行う', () => {
    expect(shouldRevisePriceInSlot('every', 21)).toBe(true)
    expect(shouldRevisePriceInSlot('morning', 21)).toBe(false)
    expect(shouldRevisePriceInSlot('morning', 9)).toBe(true)
  })

  it('slot指定があればそれを、無ければ現在時刻(JST)に最も近い時間帯を使う', () => {
    expect(resolveRunSlot('15')).toBe(15)
    expect(resolveRunSlot('7', new Date('2026-09-21T00:36:00Z'))).toBe(9) // 不正な値は時刻から判定
    // Vercel cron: 00:36 UTC = 09:36 JST → 9
    expect(resolveRunSlot(null, new Date('2026-09-21T00:36:00Z'))).toBe(9)
    // 12:05 UTC = 21:05 JST → 21
    expect(resolveRunSlot(null, new Date('2026-09-21T12:05:00Z'))).toBe(21)
    // 17:50 UTC = 02:50 JST → 3
    expect(resolveRunSlot(null, new Date('2026-09-21T17:50:00Z'))).toBe(3)
  })
})
