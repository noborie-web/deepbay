import { describe, expect, it } from 'vitest'
import { allocateSyncBudgets } from '@/lib/inventory-sync-budget'

const LIMITS = { maxItems: 800, fetchMs: 110_000 }

// 本番で確認した不具合(2026-09-26): 2アカウントにした初日、予算を単純に2等分
// したため 695件の在庫を一巡するのに2回かかるようになった。出品0件のセラーに
// 予算を取られないよう、出品件数に比例して配る。
//
// 本番で起きた事故(2026-10-24): 比例配分の下限が15秒だったため、件数の少ない
// セラーは一覧取得(GetMyeBaySelling)のガード(30秒)に毎回掛かり、全件を個別
// 照会(GetItem)していた。一覧取得は1回200件なので呼び出し回数が桁違いに増え、
// eBayの1日の上限(5,000回)を超えた。下限を一覧取得が終わる長さにする。
describe('同期の予算配分', () => {
  it('1セラーなら従来どおりの上限をそのまま使う', () => {
    expect(allocateSyncBudgets([695], LIMITS)).toEqual([
      { maxItemsPerRun: 800, fetchTotalTimeoutMs: 110_000 },
    ])
  })

  it('出品0件のセラーには最低限だけ残し、残りを出品のあるセラーに回す', () => {
    const [miyabi, akebono] = allocateSyncBudgets([695, 0], LIMITS)
    // 下限(40秒)を2セラー分先に確保し、残り30秒を出品件数で配る
    expect(miyabi).toEqual({ maxItemsPerRun: 800, fetchTotalTimeoutMs: 70_000 })
    // 出品0件でも一覧取得が終わる長さは確保する(新規出品の発見に要る)
    expect(akebono).toEqual({ maxItemsPerRun: 50, fetchTotalTimeoutMs: 40_000 })
  })

  it('両方に出品があれば件数の比率で分ける', () => {
    const [a, b] = allocateSyncBudgets([600, 200], LIMITS)
    expect(a.maxItemsPerRun).toBe(600)
    expect(b.maxItemsPerRun).toBe(200)
    expect(a.fetchTotalTimeoutMs).toBe(62_500)
    // 件数の少ないセラーも、一覧取得のガード(30秒)を超える長さは必ず確保する
    expect(b.fetchTotalTimeoutMs).toBe(47_500)
    expect(b.fetchTotalTimeoutMs).toBeGreaterThan(30_000)
  })

  // 本番で確認した不具合(2026-10-25): 下限を Math.max で後から効かせていたため
  // 配った合計が予算を超え(2,388件と399件で108.6秒 / 予算80秒)、1人目が時間を
  // 使い切って2人目(akebono-32)が同期されないまま25時間が過ぎた。
  it('配った合計は予算を超えない', () => {
    const cases: number[][] = [[2388, 399], [695, 0], [600, 200], [0, 0], [1, 9999], [100, 100, 100], [5000, 1, 1, 1]]
    for (const counts of cases) {
      const budgets = allocateSyncBudgets(counts, { maxItems: 800, fetchMs: 80_000 })
      const sum = budgets.reduce((total, b) => total + b.fetchTotalTimeoutMs, 0)
      expect(sum, `counts=${counts.join(',')}`).toBeLessThanOrEqual(80_000)
    }
  })

  it('セラーが2件なら、どちらも一覧取得のガード(30秒)を超える予算をもらう', () => {
    // 比例配分だけだと件数の少ない方が30秒を割り、全件を個別照会(GetItem)に
    // 落として呼び出し回数が桁違いに増える(2026-10-24の上限超過の原因)
    const budgets = allocateSyncBudgets([2388, 399], { maxItems: 800, fetchMs: 80_000 })
    for (const budget of budgets) expect(budget.fetchTotalTimeoutMs).toBeGreaterThan(30_000)
  })

  it('どのセラーにも出品が無ければ均等に分ける', () => {
    expect(allocateSyncBudgets([0, 0], LIMITS)).toEqual([
      { maxItemsPerRun: 400, fetchTotalTimeoutMs: 55_000 },
      { maxItemsPerRun: 400, fetchTotalTimeoutMs: 55_000 },
    ])
  })
})
