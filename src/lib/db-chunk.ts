import type { SupabaseClient } from '@supabase/supabase-js'

// 本番で確認した不具合(2026-10-20): 価格改定が一度も実行されていなかった。
// 出品2,632件のうち2,091件が改定対象なのに、cronの記録は毎回 total: 0。
//
// 原因は products を `.in('id', 1000件超のUUID)` で引いていたこと。
// URLが長くなりすぎて PostgREST が 400 を返すが、戻り値のerrorを見ていな
// かったため、商品が1件も引けていないことに気づけなかった。商品が無いと
// 「目標価格が無い」とみなされ、全件が黙って改定対象から外れていた。
// (#269 で在庫同期の同じ問題を直したが、価格改定の経路に残っていた)
//
// 1,000行というPostgRESTの既定の上限も同じ性質の罠なので、
// ここで分割取得とページ送りをまとめて引き受ける。

/** .in(...) に渡すIDの最大件数。これを超えるとURLが長すぎて400になる */
export const ID_CHUNK_SIZE = 100
/** 1回のselectで取る行数。PostgRESTの既定上限(1000)より小さくする */
export const PAGE_SIZE = 500
/** ページ送りの安全弁。これを超えたら range が効いていないとみなす */
export const MAX_PAGED_ROWS = 100_000

export function chunkIds<T>(ids: T[], size = ID_CHUNK_SIZE): T[][] {
  return Array.from(
    { length: Math.ceil(ids.length / size) },
    (_, index) => ids.slice(index * size, (index + 1) * size),
  )
}

/**
 * IDの配列で引く。分割して引き、**エラーは必ず投げる**。
 * 握りつぶすと「0件」と区別がつかず、今回のように黙って何もしなくなる。
 */
export async function selectByIds<Row>(
  db: SupabaseClient,
  table: string,
  columns: string,
  ids: string[],
  options: { idColumn?: string } = {},
): Promise<Row[]> {
  const idColumn = options.idColumn ?? 'id'
  const rows: Row[] = []
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await db.from(table).select(columns).in(idColumn, chunk)
    if (error) throw new Error(`${table} の取得に失敗しました: ${error.message}`)
    rows.push(...((data ?? []) as Row[]))
  }
  return rows
}

/**
 * 条件に合う行を全件取る(ページ送り)。
 * `.select()` だけだとPostgRESTの既定(1000行)で黙って打ち切られる。
 */
export async function selectAllRows<Row>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<Row[]> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const maxRows = options.maxRows ?? MAX_PAGED_ROWS
  const rows: Row[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw new Error(`取得に失敗しました: ${error.message}`)
    const page = (data ?? []) as Row[]
    rows.push(...page)
    if (page.length < pageSize) return rows
    // range を無視して毎回同じ行を返す相手(モック・ビュー)に当たると、
    // 終了条件が成立せず永久に回る。黙って回り続けるより落とす。
    if (rows.length > maxRows) {
      throw new Error(`ページ送りが${maxRows}行を超えました。range が効いていない可能性があります`)
    }
  }
}

/**
 * 絞り込み条件を付けたまま、IDの配列で分割して引く。
 *
 * selectByIds はテーブルと列しか渡せないので、`.eq('user_id', ...)` のような
 * 条件が要る場所では使えず、結局その場で `.in(...)` を書くことになっていた
 * (在庫管理の積み上げなど)。条件はクエリを組み立てる関数として受け取る。
 */
export async function selectInChunks<Row>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  idColumn: string,
  ids: string[],
): Promise<Row[]> {
  const rows: Row[] = []
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await buildQuery().in(idColumn, chunk)
    // エラーは必ず投げる。握りつぶすと「0件」と区別がつかない。
    if (error) throw new Error(`取得に失敗しました: ${error.message}`)
    rows.push(...((data ?? []) as Row[]))
  }
  return rows
}
