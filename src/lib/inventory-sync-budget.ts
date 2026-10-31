// ---------------------------------------------------------------------------
// 同期の予算配分(セラーごと)
//
// 本番で確認した不具合(2026-09-26): 出品アカウントを2つにした初日、1回の実行を
// 単純に2等分したため miyabi-24 の照会上限が 800→400件 に下がり、695件を一巡
// するのに2回(半日)かかるようになった。akebono-32 は出品0件で予算を使わない
// ので、配分は「そのセラーが持っている出品件数」に比例させる。
// ---------------------------------------------------------------------------

export interface SyncBudget {
  maxItemsPerRun: number
  fetchTotalTimeoutMs: number
}

export interface SyncBudgetLimits {
  maxItems: number
  fetchMs: number
}

// 出品0件のセラーにも、新しく出品した分を取り込めるだけの最低限は残す
const MIN_ITEMS = 50

// 本番で起きた事故(2026-10-24): eBayの1日の上限(5,000回)を超え、価格改定
// 1,282件のうち954件が失敗した。その日の GetItem は3,520回。
//
// 内訳を調べると、akebono-32 は cron 4回・手動9回のすべてで一括取得
// (GetMyeBaySelling)を使えておらず、全件を個別照会(GetItem)していた。
// 原因は #308 で入れた「予算30秒未満なら一括取得を使わない」ガード。
// akebono-32 の予算は出品件数の比例配分で下限15秒に張り付くため、
// 常にガードに掛かっていた。
//
// 一括取得は1回200件なので、546件なら3回・2,966件でも15回で済む。
// 個別照会は1件1回。方向が逆だったので、下限を一括取得が終わる長さにする
// (下限はセラー数で等分した値を超えないようにして、セラーが増えても
//  合計が予算を超えないようにする)。
//
// 本番で確認した不具合(2026-10-31): 40秒では akebono-32(UK/AU)の一覧取得が
// 一度も終わらず、9日間ずっと「exceeded 40000ms」だった。60秒に伸ばす。
const MIN_FETCH_MS = 60_000

export function allocateSyncBudgets(counts: number[], limits: SyncBudgetLimits): SyncBudget[] {
  if (counts.length <= 1) {
    return counts.map(() => ({ maxItemsPerRun: limits.maxItems, fetchTotalTimeoutMs: limits.fetchMs }))
  }
  // 下限が合計を食い潰さないよう、等分した値を超えない範囲で効かせる
  const fetchFloor = Math.min(MIN_FETCH_MS, Math.floor(limits.fetchMs / counts.length))
  const total = counts.reduce((sum, count) => sum + Math.max(0, count), 0)
  if (total === 0) {
    // まだどのセラーにも出品が無い(初回)。均等に分ける。
    return counts.map(() => ({
      maxItemsPerRun: Math.max(MIN_ITEMS, Math.floor(limits.maxItems / counts.length)),
      fetchTotalTimeoutMs: Math.max(fetchFloor, Math.floor(limits.fetchMs / counts.length)),
    }))
  }
  // 本番で確認した不具合(2026-10-25): 下限(40秒)を Math.max で後から効かせて
  // いたため、配った合計が予算を超えていた。出品2,388件と399件では
  // 68.6秒 + 40秒 = 108.6秒 で、80秒の予算に対して1.36倍になる。
  // 1人目が予算を食い切り、2人目(akebono-32)は実行時間の上限(300秒)に達して
  // 同期されないまま終わっていた。
  //
  // 先に全セラーへ下限を確保し、残りだけを出品件数で比例配分する。これなら
  // 合計は必ず予算に収まり、かつどのセラーも一覧取得のガード(30秒)を超える。
  const reserved = Math.min(limits.fetchMs, fetchFloor * counts.length)
  const remainder = Math.max(0, limits.fetchMs - reserved)
  const floorEach = Math.floor(reserved / counts.length)
  return counts.map(count => {
    const share = Math.max(0, count) / total
    return {
      maxItemsPerRun: Math.max(MIN_ITEMS, Math.round(limits.maxItems * share)),
      fetchTotalTimeoutMs: floorEach + Math.floor(remainder * share),
    }
  })
}
