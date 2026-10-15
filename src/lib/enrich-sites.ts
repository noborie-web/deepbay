// 商品ページから説明文・画像などを補完できる仕入先。
//
// ユーザー要望(2026-10-15): 補完の進み具合を抽出一覧でも分かるようにしたい。
// 一覧の集計(RPC)と補完API(enrich-details)で対象サイトがずれないよう、
// ここだけを正にする。
export const ENRICHABLE_SITES = ['yahoo_flea', 'yahoo_auction'] as const
export type EnrichableSite = typeof ENRICHABLE_SITES[number]
