import { describe, it, expect, vi } from 'vitest'
import { remainingEbayCalls, usedEbayCallsToday, EBAY_DAILY_CALL_LIMIT, pacificDate } from '@/lib/ebay-call-counter'
import { readFileSync } from 'fs'

function db(rows: Array<{ count: number }> | null, error?: { message: string }) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.limit = () => chain
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: error ?? null })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: vi.fn(() => chain) } as any
}

describe('eBayの1日の呼び出し枠', () => {
  // 本番で起きた事故(2026-10-24): 1日5,266回でeBayの上限(5,000)を超え、
  // 価格改定1,282件のうち954件が失敗した。
  it('その日の消費を合計する', async () => {
    expect(await usedEbayCallsToday(db([{ count: 100 }, { count: 23 }]), 'u1')).toBe(123)
  })

  it('取得できないときは握りつぶさず投げる(使い放題に戻さない)', async () => {
    await expect(usedEbayCallsToday(db(null, { message: 'boom' }), 'u1')).rejects.toThrow('boom')
  })

  it('同期・取り下げのための枠を残す', async () => {
    const left = await remainingEbayCalls(db([{ count: 1000 }]), 'u1', { reserved: 1200, limit: 5000 })
    expect(left).toBe(2800)
  })

  it('使い切っていれば0を返す(マイナスにしない)', async () => {
    expect(await remainingEbayCalls(db([{ count: 9999 }]), 'u1', { reserved: 1200, limit: 5000 })).toBe(0)
  })

  it('枠は太平洋時間の日付で切り替わる', () => {
    // 日本時間10/24 09:00 は太平洋時間では10/23
    expect(pacificDate(new Date('2026-10-24T00:00:00Z'))).toBe('2026-10-23')
  })

  it('既定の上限はeBayの標準に合わせる', () => {
    expect(EBAY_DAILY_CALL_LIMIT).toBe(5000)
  })
})

describe('呼び出し回数を減らす設定', () => {
  it('cronの同期も直近取得済みを再照会しない', () => {
    // 手動同期にはあったがcronに無く、6時間ごとに全件を引き直していた
    const src = readFileSync('src/app/api/cron/inventory-auto/route.ts', 'utf8')
    expect(src).toContain('skipFetchedWithinMs')
    expect(src).toContain('maxMissingChecksPerRun')
  })

  it('価格改定は枠を超える分を翌日に回す', () => {
    const src = readFileSync('src/lib/inventory-revise-price.ts', 'utf8')
    expect(src).toContain('deferred_daily_limit')
    expect(src).toContain('remainingEbayCalls')
  })

  it('実行記録は開始時に作る(強制終了されても残るように)', () => {
    const src = readFileSync('src/app/api/cron/revise-price/route.ts', 'utf8')
    expect(src).toContain("status: 'running'")
  })
})
