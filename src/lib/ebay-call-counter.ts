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
