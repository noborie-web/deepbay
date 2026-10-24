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
    expect(miyabi).toEqual({ maxItemsPerRun: 800, fetchTotalTimeoutMs: 110_000 })
    // 出品0件でも一覧取得が終わる長さは確保する(新規出品の発見に要る)
    expect(akebono).toEqual({ maxItemsPerRun: 50, fetchTotalTimeoutMs: 40_000 })
  })

  it('両方に出品があれば件数の比率で分ける', () => {
    const [a, b] = allocateSyncBudgets([600, 200], LIMITS)
    expect(a.maxItemsPerRun).toBe(600)
    expect(b.maxItemsPerRun).toBe(200)
    expect(a.fetchTotalTimeoutMs).toBe(82_500)
    // 比例配分では27.5秒だが、一覧取得のガード(30秒)に掛かって個別照会に
    // 落ちてしまうので、下限の40秒まで引き上げる
    expect(b.fetchTotalTimeoutMs).toBe(40_000)
  })

  it('どのセラーにも出品が無ければ均等に分ける', () => {
    expect(allocateSyncBudgets([0, 0], LIMITS)).toEqual([
      { maxItemsPerRun: 400, fetchTotalTimeoutMs: 55_000 },
      { maxItemsPerRun: 400, fetchTotalTimeoutMs: 55_000 },
    ])
  })
})
