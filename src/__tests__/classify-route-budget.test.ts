import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// 本番で確認した不具合(2026-10-19): 567件の判定が123件で「Failed to fetch」に
// なった。gpt-5-miniは推論する分だけ遅く、1回100件が60秒の実行上限に収まらず
// 関数が強制終了していた(書き込みの間隔が59秒だった)。
//
// 打ち切りの時刻(TIME_BUDGET_MS)を過ぎても、進行中の1件は最大40秒
// (20秒のタイムアウト × 再試行1回)かかる。その合計が実行上限を超えると
// 応答を返せず、同じ症状が再発する。数値で固定しておく。
const source = readFileSync('src/app/api/products/[extractionId]/classify/route.ts', 'utf8')

function numberOf(name: string): number {
  const match = source.match(new RegExp(`${name}\\s*=\\s*([0-9_]+)`))
  if (!match) throw new Error(`${name} が見つかりません`)
  return Number(match[1].replace(/_/g, ''))
}

describe('判定APIの時間設計', () => {
  const maxDuration = numberOf('maxDuration')
  const timeBudgetMs = numberOf('TIME_BUDGET_MS')
  const worstCaseCallMs = 40_000 // 20秒 × (初回 + 再試行1回)

  it('打ち切り時刻 + 進行中の1件 が実行上限を超えない', () => {
    expect(timeBudgetMs + worstCaseCallMs).toBeLessThan(maxDuration * 1000)
  })

  it('60秒では足りないため、実行上限を上げている', () => {
    expect(maxDuration).toBeGreaterThan(60)
  })
})
