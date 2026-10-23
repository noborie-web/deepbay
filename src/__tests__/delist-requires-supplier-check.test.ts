import { describe, it, expect, vi } from 'vitest'
import { onlyVerifiedSoldOut } from '@/lib/inventory-listing-filter'

function recorder() {
  const calls: Array<[string, ...unknown[]]> = []
  const q: Record<string, unknown> = {}
  for (const name of ['not', 'eq', 'is', 'in', 'lte', 'order', 'select']) {
    q[name] = (...args: unknown[]) => { calls.push([name, ...args]); return q }
  }
  return { q, calls }
}

describe('売り切れ取り下げは仕入先チェック済みに限る', () => {
  // 本番で起きた事故(2026-10-23): eBayレポートの取り込みで2,305行が
  // quantity=0 のまま作られ、直後のcronが656件に Revise(quantity=0) を送った。
  // 抜き取り20件のうち13件(65%)は、その時点でも即決価格で購入できた。
  // quantity=0 だけを根拠に出品を止めない。
  it('supplier_checked_at が null の出品を除外する', () => {
    const { q, calls } = recorder()
    onlyVerifiedSoldOut(q)
    expect(calls).toContainEqual(['not', 'supplier_checked_at', 'is', null])
  })

  it('クエリをそのまま返すので連結できる', () => {
    const { q } = recorder()
    expect(onlyVerifiedSoldOut(q)).toBe(q)
  })
})

describe('取り下げの対象を引く全経路に条件が入っている', () => {
  // 1箇所でも漏れるとそこから同じ事故が起きるので、呼び出し側を固定する
  it('cron・quick-check・手動・CSV出力のすべてで使われている', async () => {
    const { readFileSync } = await import('fs')
    const paths = [
      'src/app/api/cron/inventory-auto/route.ts',
      'src/lib/inventory-quick-check.ts',
      'src/app/api/inventory/actions/delist/route.ts',
      'src/app/api/inventory/actions/export-csv/route.ts',
    ]
    for (const path of paths) {
      expect(readFileSync(path, 'utf8'), path).toContain('onlyVerifiedSoldOut')
    }
  })
})
