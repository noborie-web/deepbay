import { describe, expect, it } from 'vitest'
import {
  CONDITION_GRADES,
  CONDITION_GRADE_GROUPS,
  EBAY_CONDITION_OPTIONS,
  MEDIA_CONDITION_MAP,
  STANDARD_CONDITION_MAP,
  conditionTone,
} from '@/lib/listing-export'

// 設定UIは CONDITION_GRADE_GROUPS を表示するので、グループから漏れた状態が
// あると「設定したつもりなのに変換されない」状態になる。
describe('商品状態→ConditionID 設定UIの表示グループ', () => {
  it('すべての商品状態がどれかのグループに入っている', () => {
    const grouped = CONDITION_GRADE_GROUPS.flatMap((g) => g.grades)
    expect([...grouped].sort()).toEqual([...CONDITION_GRADES].sort())
  })

  it('同じ状態が複数のグループに重複して出てこない', () => {
    const grouped = CONDITION_GRADE_GROUPS.flatMap((g) => g.grades)
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('プリセットの値はすべて選択肢に存在する', () => {
    const ids = new Set(EBAY_CONDITION_OPTIONS.map((o) => o.id))
    for (const map of [STANDARD_CONDITION_MAP, MEDIA_CONDITION_MAP]) {
      for (const [grade, id] of Object.entries(map)) {
        expect(ids.has(id), `${grade} → ${id}`).toBe(true)
      }
    }
  })

  it('選択肢すべてに色分けの区分が決まる', () => {
    for (const { id } of EBAY_CONDITION_OPTIONS) {
      expect(['new', 'likeNew', 'used', 'poor']).toContain(conditionTone(id))
    }
  })

  it('新品系と中古系が取り違えられていない', () => {
    expect(conditionTone('1000')).toBe('new')
    expect(conditionTone('2750')).toBe('likeNew')
    expect(conditionTone('3000')).toBe('used')
    expect(conditionTone('7000')).toBe('poor')
  })
})
