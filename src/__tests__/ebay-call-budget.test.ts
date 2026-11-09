import { describe, it, expect, vi } from 'vitest'
import { remainingEbayCalls, usedEbayCallsToday, ebayCallLimitFor, EBAY_DAILY_CALL_LIMIT, pacificDate } from '@/lib/ebay-call-counter'
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

  // 本番データ(2026-11-01): 10/19に6,653回を上限エラーなしで処理できている。
  // 合計5,000回という上限は実在しないので、実績を上回る値にする。
  it('既定の上限は実績を上回る値にする', () => {
    expect(EBAY_DAILY_CALL_LIMIT).toBe(10000)
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

// 本番で確認した不具合(2026-11-08): 11/6(太平洋時間)に同期が
// 「Your application has exceeded usage limit on this call」で失敗した。
//   11/6  GetItem   671 + ReviseInventoryStatus 2,109 = 2,795回 → 失敗
//   11/7  GetItem 3,857 + ReviseInventoryStatus   306 = 4,200回 → 正常
// 合計では説明がつかない。異常だったのは ReviseInventoryStatus だけで
// (平常128〜399回)、eBayのエラー文も「on this call」。枠は呼び出し名ごと。
describe('呼び出し名ごとの枠', () => {
  // 呼び出し名で絞って数えていることを、絞り込みの記録で確かめる
  function dbWithFilters(rows: Array<{ count: number }>) {
    const filters: Array<[string, unknown]> = []
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (column: string, value: unknown) => { filters.push([column, value]); return chain }
    chain.limit = () => chain
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { db: { from: vi.fn(() => chain) } as any, filters }
  }

  it('GetItem と ReviseInventoryStatus に別々の上限を持つ', () => {
    expect(ebayCallLimitFor('GetItem')).toBe(4500)
    expect(ebayCallLimitFor('ReviseInventoryStatus')).toBe(1000)
    // 設定の無い呼び出しは全体の既定値に落とす
    expect(ebayCallLimitFor('GetSellerList')).toBe(EBAY_DAILY_CALL_LIMIT)
    expect(ebayCallLimitFor()).toBe(EBAY_DAILY_CALL_LIMIT)
  })

  it('指定した呼び出し名の分だけ数える', async () => {
    const { db: database, filters } = dbWithFilters([{ count: 300 }])
    await usedEbayCallsToday(database, 'u1', new Date('2026-11-08T12:00:00Z'), 'ReviseInventoryStatus')
    expect(filters).toContainEqual(['call_name', 'ReviseInventoryStatus'])
  })

  it('呼び出し名を指定しなければ全部を数える(従来どおり)', async () => {
    const { db: database, filters } = dbWithFilters([{ count: 300 }])
    await usedEbayCallsToday(database, 'u1')
    expect(filters.some(([column]) => column === 'call_name')).toBe(false)
  })

  it('残量はその呼び出し名の上限から引く', async () => {
    // 平常の価格改定(306回)はまだ余裕がある
    expect(await remainingEbayCalls(db([{ count: 306 }]), 'u1', { callName: 'ReviseInventoryStatus' }))
      .toBe(694)
    // ここが本題。11/6の2,109回なら0で止まり、同期を巻き添えにしない
    expect(await remainingEbayCalls(db([{ count: 2109 }]), 'u1', { callName: 'ReviseInventoryStatus' }))
      .toBe(0)
    // 同じ日でも GetItem の枠は別なので、平常どおり使える
    expect(await remainingEbayCalls(db([{ count: 671 }]), 'u1', { callName: 'GetItem' }))
      .toBe(3829)
  })
})
