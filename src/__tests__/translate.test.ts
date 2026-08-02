import { describe, expect, it } from 'vitest'
import { _translateTitlesInBatches } from '../lib/translate'

describe('translateTitles batching', () => {
  it('587件を1件ずつではなく15バッチで処理する', async () => {
    const titles = Array.from({ length: 587 }, (_, index) => `商品 ${index + 1}`)
    const batchSizes: number[] = []

    const translated = await _translateTitlesInBatches(
      titles,
      async (batch) => {
        batchSizes.push(batch.length)
        return batch.map((title) => `EN ${title}`)
      },
    )

    expect(batchSizes).toHaveLength(15)
    expect(batchSizes.slice(0, -1)).toEqual(Array(14).fill(40))
    expect(batchSizes.at(-1)).toBe(27)
    expect(translated).toHaveLength(587)
    expect(translated[0]).toBe('EN 商品 1')
    expect(translated.at(-1)).toBe('EN 商品 587')
  })

  it('同時に実行する翻訳バッチを最大3件に制限する', async () => {
    const titles = Array.from({ length: 240 }, (_, index) => `商品 ${index + 1}`)
    let active = 0
    let maxActive = 0

    await _translateTitlesInBatches(titles, async (batch) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return batch
    })

    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('バッチ失敗時はそのバッチだけ元タイトルを維持する', async () => {
    const titles = ['商品1', '商品2', '商品3', '商品4']
    let callCount = 0

    const translated = await _translateTitlesInBatches(
      titles,
      async (batch) => {
        callCount += 1
        if (callCount === 2) throw new Error('temporary error')
        return batch.map((title) => `EN ${title}`)
      },
      undefined,
      2,
      2,
    )

    expect(translated).toEqual(['EN 商品1', 'EN 商品2', '商品3', '商品4'])
  })

  it('進捗通知の最終値が総件数と一致する', async () => {
    const progress: Array<[number, number]> = []
    const titles = Array.from({ length: 95 }, (_, index) => `商品 ${index + 1}`)

    await _translateTitlesInBatches(
      titles,
      async (batch) => batch,
      (completed, total) => {
        progress.push([completed, total])
      },
      20,
      2,
    )

    expect(progress.at(-1)).toEqual([95, 95])
  })
})
