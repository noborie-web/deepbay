import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from '@/lib/async-pool'

describe('mapWithConcurrency', () => {
  it('入力の順番どおりに結果を返す', async () => {
    const delays = [30, 1, 20, 2, 10]
    const result = await mapWithConcurrency(delays, 3, async (ms, idx) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return `${idx}:${ms}`
    })
    expect(result).toEqual(['0:30', '1:1', '2:20', '3:2', '4:10'])
  })

  it('同時実行数を超えない', async () => {
    let running = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running -= 1
    })
    expect(peak).toBe(4)
  })

  it('チャンク方式と違い、遅い1件が他のワーカーを止めない', async () => {
    // 1件だけ100ms、残り11件は1ms。チャンク(4件ずつ直列)なら最初のチャンクで
    // 100ms待ってから次に進むため合計100ms+αだが、プールなら遅い1件の裏で
    // 残り全件を処理できる。
    const items = [100, ...Array.from({ length: 11 }, () => 1)]
    const startedAt = Date.now()
    await mapWithConcurrency(items, 4, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    })
    expect(Date.now() - startedAt).toBeLessThan(150)
  })

  it('空配列は呼び出さずに空を返す', async () => {
    let calls = 0
    const result = await mapWithConcurrency([], 4, async () => { calls += 1 })
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })
})
