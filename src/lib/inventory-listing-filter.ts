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

/**
 * 「売り切れ」として取り下げてよい出品に絞る。
 *
 * 本番で起きた事故(2026-10-23): eBayレポートの取り込みで2,305行が
 * quantity=0 のまま作られ、その直後のcronが656件に Revise(quantity=0) を
 * 送った。取り下げの条件が「quantity = 0」だけで、仕入先チェックの結果を
 * 一切見ていなかったため。抜き取り20件のうち13件(65%)は、その時点でも
 * 即決価格で普通に購入できる商品だった。
 *
 * quantity=0 は「仕入先が売り切れた」以外に、同期や取り込みの値がそのまま
 * 入っただけのことがある。売り切れを理由に出品を止める以上、仕入先を実際に
 * 確認した証拠(supplier_checked_at)を必須にする。
 */
export function onlyVerifiedSoldOut<T>(query: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (query as any).not('supplier_checked_at', 'is', null)
}
