// ユーザー要望: 在庫管理の1日の稼働回数を増やしたい(最大4回)。
// Vercel Hobby の cron は1日1回・時刻不定のため、Supabase の pg_cron から
// 00/06/12/18 UTC(09/15/21/03 JST)に /api/cron/inventory-auto?slot={JST時} を
// 呼び出し、ユーザーごとの稼働回数に応じてその時間帯を処理するか判定する。

export const RUN_SLOT_HOURS_JST = [3, 9, 15, 21] as const
export type RunSlotHour = (typeof RUN_SLOT_HOURS_JST)[number]
export const MORNING_SLOT_HOUR: RunSlotHour = 9

export type RevisePriceSchedule = 'every' | 'morning'

export function normalizeDailyRunCount(value: unknown): 1 | 2 | 3 | 4 {
  const n = typeof value === 'string' ? Number(value) : value
  if (n === 2 || n === 3 || n === 4) return n
  return 1
}

export function normalizeRevisePriceSchedule(value: unknown): RevisePriceSchedule {
  return value === 'morning' ? 'morning' : 'every'
}

// 稼働回数ごとの実行時間帯(JST)。朝9時は必ず含める。
export function slotsForRunCount(count: number): RunSlotHour[] {
  switch (normalizeDailyRunCount(count)) {
    case 4: return [3, 9, 15, 21]
    case 3: return [9, 15, 21]
    case 2: return [9, 21]
    default: return [9]
  }
}

export function isSlotActive(count: number, slot: RunSlotHour): boolean {
  return slotsForRunCount(count).includes(slot)
}

// 価格改定(eBayへの反映)をこの時間帯に行うか。'morning' なら朝9時のみ。
export function shouldRevisePriceInSlot(schedule: RevisePriceSchedule, slot: RunSlotHour): boolean {
  return schedule === 'every' || slot === MORNING_SLOT_HOUR
}

// 現在時刻(UTC)から最も近い実行時間帯(JST)を求める。Vercel cron(00:00 UTC
// 指定だが実際は00:00〜00:59に発火)など、slot 指定が無い呼び出し用。
export function resolveRunSlot(slotParam: string | null | undefined, now: Date = new Date()): RunSlotHour {
  const parsed = slotParam !== null && slotParam !== undefined ? Number(slotParam) : NaN
  if (RUN_SLOT_HOURS_JST.includes(parsed as RunSlotHour)) return parsed as RunSlotHour
  const jstHour = (now.getUTCHours() + 9 + now.getUTCMinutes() / 60) % 24
  let best: RunSlotHour = 9
  let bestDistance = Infinity
  for (const slot of RUN_SLOT_HOURS_JST) {
    const distance = Math.min(Math.abs(jstHour - slot), 24 - Math.abs(jstHour - slot))
    if (distance < bestDistance) { best = slot; bestDistance = distance }
  }
  return best
}

export function formatSlotHours(slots: RunSlotHour[]): string {
  return slots.map(h => `${h}:00`).join(' / ')
}

// 同じ時間帯(slot)の実行が今日すでにあるかを判定するための、その日(JST)の開始時刻。
// 本番で確認した問題(2026-09-24): 手動の「今すぐ実行」直後は、90分以内の実行を
// 一律スキップしていたため、次の定時実行(21:00)まで飛ばされていた。
// 「同じ時間帯の実行が今日あったか」で判定すれば、手動実行が定時実行を潰さない。
export function startOfJstDay(now: Date = new Date()): Date {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 60 * 60 * 1000)
}
