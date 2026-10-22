import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { auditDbQueries, totalFindings, type AuditCounts } from './helpers/db-query-audit'

const BASELINE_PATH = 'src/__tests__/db-query-safety-baseline.json'

/**
 * 「黙って0件になる」書き方のラチェット。
 *
 * 新しく増えたら落ちる。減らしたときは下のコマンドでベースラインを更新する:
 *   UPDATE_DB_QUERY_BASELINE=1 npx vitest run src/__tests__/db-query-safety.test.ts
 *
 * 既存分を全部直すまで止める、という運用は現実的でないので(91箇所ある)、
 * まず「これ以上増やさない」ことだけを保証する。
 */
describe('DBクエリの安全性(ラチェット)', () => {
  const current = auditDbQueries('src')

  if (process.env.UPDATE_DB_QUERY_BASELINE === '1') {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n')
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as AuditCounts

  it('「黙って0件になる」書き方を増やしていない', () => {
    const worse: string[] = []
    for (const [file, kinds] of Object.entries(current)) {
      for (const [kind, count] of Object.entries(kinds)) {
        const allowed = baseline[file]?.[kind as keyof typeof kinds] ?? 0
        if (count > allowed) {
          worse.push(`${file}: ${kind} が ${allowed} → ${count} に増えています`)
        }
      }
    }
    expect(worse, [
      '',
      'PostgRESTの既定は「黙って0件」になる形で失敗します:',
      '  unbounded_in     … .in() にIDを100件超渡すとURLが長すぎて400',
      '  unbounded_select … 件数上限なしの取得は既定1,000行で打ち切られる',
      '  ignored_error    … error を受け取らないと失敗が0件と区別できない',
      '',
      '対処: src/lib/db-chunk.ts の selectByIds / selectAllRows を使い、',
      '      error は握りつぶさず投げる。',
      '',
    ].join('\n')).toEqual([])
  })

  it('ベースラインが実態より緩くなっていない(直したら締める)', () => {
    const stale: string[] = []
    for (const [file, kinds] of Object.entries(baseline)) {
      for (const [kind, allowed] of Object.entries(kinds)) {
        const count = current[file]?.[kind as keyof typeof kinds] ?? 0
        if (count < allowed) {
          stale.push(`${file}: ${kind} が ${allowed} → ${count} に減りました。ベースラインを更新してください`)
        }
      }
    }
    expect(stale).toEqual([])
  })

  it('ベースラインの総数を記録しておく(減っていく想定)', () => {
    // 2026-10-23 時点: 147件(error無視66 / 上限なし取得55 / 無制限.in 26)。
    // cron配下(無人で動くので誰も気づけない)は0件にした。減らす方向にしか動かさない。
    expect(totalFindings(baseline)).toBeLessThanOrEqual(147)
  })
})

describe('cron配下(無人で動く経路)', () => {
  // 今回の事故はすべてcron配下で起き、誰も見ていないので数日〜1か月気づけ
  // なかった。ここだけは0件を維持する。
  it('「黙って0件になる」書き方が1つも無い', () => {
    const counts = auditDbQueries('src/app/api/cron')
    expect(counts).toEqual({})
  })
})
