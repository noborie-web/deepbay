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

  it('出品0件のセラーにも一覧取得が終わる長さは確保し、照会件数だけ比率で配る', () => {
    const [miyabi, akebono] = allocateSyncBudgets([695, 0], LIMITS)
    // 個別照会(GetItem)の件数は、その セラーが持っている出品の比率どおりに配る
    expect(miyabi.maxItemsPerRun).toBe(800)
    expect(akebono.maxItemsPerRun).toBe(50)
    // 出品0件でも一覧取得が終わる長さは確保する(新規出品の発見に要る)
    expect(akebono.fetchTotalTimeoutMs).toBeGreaterThanOrEqual(40_000)
  })

  it('一覧取得の時間は比率で削らず、どのセラーにも下限(60秒)を確保する', () => {
    // 一覧取得(GetMyeBaySelling)に掛かる時間は、そのセラーのアカウント全体の
    // 出品数で決まる。Kakehashiが持っている件数の比率で削ると、件数の少ない
    // セラーが毎回時間切れになる(akebono-32 が9日間更新されなかった原因)。
    const [a, b] = allocateSyncBudgets([600, 200], LIMITS)
    expect(a.maxItemsPerRun).toBe(600)
    expect(b.maxItemsPerRun).toBe(200)
    expect(a.fetchTotalTimeoutMs).toBe(55_000)
    expect(b.fetchTotalTimeoutMs).toBe(55_000)
  })

  // 本番で確認した不具合(2026-10-31): 2セラーで80秒だと1人40秒。akebono-32
  // (UK/AU)の一覧取得は40秒では一度も終わらず、4回/日×9日間すべてが
  // 「exceeded 40000ms」だった。本番と同じ120秒なら1人60秒になる。
  it('本番の予算(120秒・2セラー)なら1人60秒になる', () => {
    const budgets = allocateSyncBudgets([3370, 1023], { maxItems: 800, fetchMs: 120_000 })
    for (const budget of budgets) expect(budget.fetchTotalTimeoutMs).toBe(60_000)
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
