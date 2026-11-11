import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEbayRateLimits, rateLimitFor } from '@/lib/ebay-rate-limits'

// ---------------------------------------------------------------------------
// eBay APIの呼び出し回数の記録
//
// ユーザー要望(2026-09-30): APIの容量と消費が見えるようにしたい。
// eBayの GetApiAccessRules は廃止(HTTP 410)されていて使えないため、
// Kakehashiが送った回数を自分で数える。呼び出しのたびにDBへ書くと重いので、
// 1リクエストの処理中はメモリに貯め、最後にまとめて記録する。
// ---------------------------------------------------------------------------

const counts = new Map<string, number>()

export function recordEbayCall(callName: string, times = 1): void {
  counts.set(callName, (counts.get(callName) ?? 0) + times)
}

export function takeEbayCallCounts(): Array<{ callName: string; count: number }> {
  const entries = Array.from(counts.entries()).map(([callName, count]) => ({ callName, count }))
  counts.clear()
  return entries
}

/** eBayの呼び出し枠は太平洋時間の日付で切り替わる */
export function pacificDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * 貯めた回数をDBに記録する。失敗しても本来の処理は止めない。
 */
export async function flushEbayCallCounts(db: SupabaseClient, userId: string, now = new Date()): Promise<void> {
  const entries = takeEbayCallCounts()
  if (entries.length === 0) return
  try {
    const calledOn = pacificDate(now)
    const { error } = await db.from('ebay_api_calls').insert(
      entries.map(entry => ({ user_id: userId, called_on: calledOn, call_name: entry.callName, count: entry.count })),
    )
    if (error) console.warn('[ebay-call-counter] failed to record api calls:', error.message)
  } catch (error) {
    console.warn('[ebay-call-counter] failed to record api calls:', error instanceof Error ? error.message : error)
  }
}

// ---------------------------------------------------------------------------
// 1日あたりの呼び出し枠
//
// 本番で起きた事故(2026-10-24): 価格改定1,282件のうち954件が
// 「Your application has exceeded usage limit on this call」で失敗した。
// その日の消費は GetItem 3,520 + ReviseInventoryStatus 1,482 +
// GetMyeBaySelling 250 + GetSellerList 14 = 5,266回で、eBayの標準上限
// (5,000回/日)を超えていた。
//
// 枠を使い切ってから失敗するのではなく、残りを見て先に止める。
// 売り切れの検知(取り下げ)は価格改定より優先度が高いので、価格改定には
// 少なめの枠を割り当て、残りは翌日に回す。
// ---------------------------------------------------------------------------

/** eBayの標準上限。使い切る手前で止めるため、少し小さく見積もる */
// 本番データで確認(2026-11-01): 5,000という値に根拠が無かった。
//   10/19  合計 6,653回  上限エラーなし
//   10/23  合計 5,266回  上限エラーあり(価格改定のみ)
//   上限エラーは同期444回中2回だけ(最後は10/20)
// 6,653回を問題なく処理できた日がある以上、合計5,000回という上限は実在しない。
//
// さらに10/24のエラー文は「exceeded usage limit on this call」で、eBayの枠は
// 呼び出し名ごとに分かれている。10/23も合計ではなく ReviseInventoryStatus 単独の
// 枠に当たっており(同じ日にGetItemは約3,500回成功)、合計で見るモデル自体が
// eBayの実態と合っていない。呼び出し名ごとの枠に作り変えるまでの暫定値として、
// 実績のある6,653回を上回る10,000にする。
//
// 実際の上限は developer.ebay.com の Application Growth Check でしか分からない
// (GetApiAccessRules は廃止・HTTP 410)。判明したら環境変数で設定する。
export const EBAY_DAILY_CALL_LIMIT = Number(process.env.EBAY_DAILY_CALL_LIMIT ?? 10000)
/** 同期・取り下げ用に必ず残しておく分 */
export const EBAY_RESERVED_CALLS = Number(process.env.EBAY_RESERVED_CALLS ?? 1200)

// 呼び出し名ごとの1日の上限。
//
// 本番で確認した不具合(2026-11-08): 11/6(太平洋時間)に同期が
// 「Your application has exceeded usage limit on this call」で失敗した。
// その日の消費は GetItem 671 + ReviseInventoryStatus 2,109 = 2,795回。
// 一方 11/7 は GetItem 3,857 + Revise 306 = 4,200回で正常だった。
// 合計では説明がつかず、異常だったのは ReviseInventoryStatus だけ
// (平常は128〜399回なので5〜16倍)。eBayのエラー文も「on this call」で、
// 枠は呼び出し名ごとに分かれている。合計で見るのをやめる。
//
// 実際の上限は developer.ebay.com の Application Growth Check でしか
// 分からない(GetApiAccessRules は廃止・HTTP 410)。判明するまでの値として、
// 平常の消費を妨げず、11/6のような急増だけを止める水準にする。
//   GetItem                3,000〜4,052回/日 が正常 → 4,500
//   ReviseInventoryStatus    128〜399回/日 が正常   → 1,000
const EBAY_CALL_LIMITS: Record<string, number> = {
  GetItem: Number(process.env.EBAY_LIMIT_GET_ITEM ?? 4500),
  ReviseInventoryStatus: Number(process.env.EBAY_LIMIT_REVISE_INVENTORY_STATUS ?? 1000),
}

/** その呼び出し名の1日の上限。設定が無ければ全体の既定値を使う */
export function ebayCallLimitFor(callName?: string): number {
  if (!callName) return EBAY_DAILY_CALL_LIMIT
  return EBAY_CALL_LIMITS[callName] ?? EBAY_DAILY_CALL_LIMIT
}

/**
 * 太平洋時間の今日、これまでに送った回数。
 * callName を指定すると、その呼び出し名の分だけ数える。
 */
export async function usedEbayCallsToday(
  db: SupabaseClient,
  userId: string,
  now = new Date(),
  callName?: string,
): Promise<number> {
  // 1日・1ユーザーの行数は呼び出し名の数だけだが、上限を付けない書き方は
  // そのまま残すと別の場所で真似される(#db-query-safety)
  // db-audit-ok: 下で .limit(500) を付けて引く(組み立てが別の文)
  let query = db
    .from('ebay_api_calls')
    .select('count')
    .eq('user_id', userId)
    .eq('called_on', pacificDate(now))
  if (callName) query = query.eq('call_name', callName)
  const { data, error } = await query.limit(500)
  // 取得できないときは「使っていない」ではなく「分からない」。
  // 握りつぶして使い放題にすると上限超過に戻るので、上限扱いにして止める。
  if (error) throw new Error(`eBay呼び出し回数を取得できませんでした: ${error.message}`)
  return (data ?? []).reduce((sum, row) => sum + Number(row.count ?? 0), 0)
}

/**
 * この処理に使ってよい残り回数。
 * reserved は他の処理(同期・取り下げ)のために残す分。
 */
export async function remainingEbayCalls(
  db: SupabaseClient,
  userId: string,
  options: { reserved?: number; limit?: number; now?: Date; callName?: string } = {},
): Promise<number> {
  const reserved = options.reserved ?? 0

  // eBayが持っている実際の残りを優先する。
  //
  // 本番で確認した不具合(2026-11-08〜09): 11/7は3,857回通り、11/8は2,238回で
  // 拒否された。Kakehashiが数えていた「太平洋時間の暦日あたりの回数」では
  // 説明がつかず、上限値も時間の区切りも推測だった。eBay自身が残りと時間窓を
  // 返すので、それを使えば推測がいらなくなる。
  if (options.limit === undefined && options.callName) {
    try {
      const live = rateLimitFor(await fetchEbayRateLimits(), options.callName)
      if (live) return Math.max(0, live.remaining - reserved)
    } catch (error) {
      // 取れなくても止めない。自前の集計に落ちる(従来どおりの動き)。
      console.warn('[ebay-call-counter] 呼び出し枠を取得できませんでした:', error instanceof Error ? error.message : error)
    }
  }

  const limit = options.limit ?? ebayCallLimitFor(options.callName)
  const used = await usedEbayCallsToday(db, userId, options.now, options.callName)
  return Math.max(0, limit - reserved - used)
}
