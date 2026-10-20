import { describe, expect, it } from 'vitest'
import { itemIdsToRun, selectByPastedIds } from '@/lib/action-selection'

// ユーザー要望(2026-10-20): 価格改定をプレビュー全件ではなく、確認した分だけ
// 実行したい。実データでは値上げ対象1,782件のうち、仕入値が実際に上がって
// いたのは44件だけだった。全件反映すると残りまで値上げしてしまう。

const available = ['111', '222', '333']

describe('selectByPastedIds', () => {
  it('貼ったIDだけを選ぶ', () => {
    expect(selectByPastedIds(available, '111,333')).toEqual(new Set(['111', '333']))
  })

  it('改行・空白区切りでも読む', () => {
    expect(selectByPastedIds(available, '111\n222  333')).toEqual(new Set(available))
  })

  // プレビューに無いIDを送ると、意図しない出品を触りかねない
  it('プレビューに無いIDは無視する', () => {
    expect(selectByPastedIds(available, '111,999')).toEqual(new Set(['111']))
  })

  it('空なら全件に戻す（絞り込み解除）', () => {
    expect(selectByPastedIds(available, '')).toEqual(new Set(available))
    expect(selectByPastedIds(available, '   ')).toEqual(new Set(available))
  })
})

describe('itemIdsToRun', () => {
  it('選んだものだけを、プレビューの並び順で返す', () => {
    expect(itemIdsToRun(available, new Set(['333', '111']))).toEqual(['111', '333'])
  })

  it('何も選んでいなければ空（誤って全件実行しない）', () => {
    expect(itemIdsToRun(available, new Set())).toEqual([])
  })
})
