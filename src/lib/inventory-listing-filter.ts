/**
 * 価格改定の対象を「eBayに生きている出品」だけに絞る。
 *
 * 本番で確認した無駄(2026-10-22): 価格改定の対象抽出に在庫数・取り下げ済みの
 * 絞り込みが無く、既に取り下げた373件にもReviseを送っていた。在庫0なので
 * 売れてしまう心配は無いが、1回240秒の時間予算を食うぶん、本来直すべき出品が
 * 翌日に持ち越される。
 *
 * 在庫数が不明(null)の出品は含める。eBayには生きている出品で、改定しないと
 * 価格が古いまま残る。PostgreSQLでは null > 0 が真にならないため
 * `.gt('quantity', 0)` だけで絞ると取りこぼす(仕入先チェックで同じ取りこぼしを
 * 起こした実績がある: 在庫数不明の84件が一度もチェックされていなかった)。
 */
export function onlyLiveListings<T>(query: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (query as any)
    .is('delisted_at', null)
    .or('quantity.gt.0,quantity.is.null')
}
