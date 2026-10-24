import type { SupabaseClient } from '@supabase/supabase-js'

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
export const EBAY_DAILY_CALL_LIMIT = Number(process.env.EBAY_DAILY_CALL_LIMIT ?? 5000)
/** 同期・取り下げ用に必ず残しておく分 */
export const EBAY_RESERVED_CALLS = Number(process.env.EBAY_RESERVED_CALLS ?? 1200)

/** 太平洋時間の今日、これまでに送った回数 */
export async function usedEbayCallsToday(
  db: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<number> {
  // 1日・1ユーザーの行数は呼び出し名の数だけだが、上限を付けない書き方は
  // そのまま残すと別の場所で真似される(#db-query-safety)
  const { data, error } = await db
    .from('ebay_api_calls')
    .select('count')
    .eq('user_id', userId)
    .eq('called_on', pacificDate(now))
    .limit(500)
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
  options: { reserved?: number; limit?: number; now?: Date } = {},
): Promise<number> {
  const limit = options.limit ?? EBAY_DAILY_CALL_LIMIT
  const reserved = options.reserved ?? 0
  const used = await usedEbayCallsToday(db, userId, options.now)
  return Math.max(0, limit - reserved - used)
}
