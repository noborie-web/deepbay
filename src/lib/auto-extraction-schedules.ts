import type { SupabaseClient } from '@supabase/supabase-js'

export type AutoExtractionProcessType = 'extract' | 'extract_and_list'

export interface AutoExtractionScheduleInput {
  name?: string | null
  source_url?: string
  seller_account_id?: string | null
  category_id?: string | null
  bulk_edit_setting_id?: string | null
  process_type?: AutoExtractionProcessType
  schedule_day_of_month?: number
  schedule_time?: string
  enabled?: boolean
}

const PROCESS_TYPES = new Set<AutoExtractionProcessType>(['extract', 'extract_and_list'])
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function optionalId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return typeof value === 'string' ? value : undefined
}

export function parseAutoExtractionScheduleInput(
  body: unknown,
  partial = false,
): { data?: AutoExtractionScheduleInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'リクエスト内容が不正です' }
  }
  const source = body as Record<string, unknown>
  const data: AutoExtractionScheduleInput = {}

  if (!partial || 'source_url' in source) {
    if (typeof source.source_url !== 'string' || !source.source_url.trim()) {
      return { error: '抽出対象URLは必須です' }
    }
    try {
      const url = new URL(source.source_url.trim())
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
      data.source_url = url.toString()
    } catch {
      return { error: '有効なURLを入力してください' }
    }
  }

  if ('name' in source) {
    if (source.name !== null && typeof source.name !== 'string') return { error: 'スケジュール名が不正です' }
    data.name = typeof source.name === 'string' ? source.name.trim() || null : null
  } else if (!partial) {
    data.name = null
  }

  for (const key of ['seller_account_id', 'category_id', 'bulk_edit_setting_id'] as const) {
    if (!(key in source)) {
      if (partial) continue
      data[key] = null
      continue
    }
    const value = optionalId(source[key])
    if (value === undefined) return { error: `${key}が不正です` }
    data[key] = value
  }

  if (!partial || 'process_type' in source) {
    if (typeof source.process_type !== 'string' || !PROCESS_TYPES.has(source.process_type as AutoExtractionProcessType)) {
      return { error: '処理タイプが不正です' }
    }
    data.process_type = source.process_type as AutoExtractionProcessType
  }

  if (!partial || 'schedule_day_of_month' in source) {
    if (!Number.isInteger(source.schedule_day_of_month)
      || Number(source.schedule_day_of_month) < 1
      || Number(source.schedule_day_of_month) > 28) {
      return { error: '実行日は1〜28で指定してください' }
    }
    data.schedule_day_of_month = Number(source.schedule_day_of_month)
  }

  if (!partial || 'schedule_time' in source) {
    if (typeof source.schedule_time !== 'string' || !TIME_PATTERN.test(source.schedule_time)) {
      return { error: '実行時刻はHH:MM形式で指定してください' }
    }
    data.schedule_time = source.schedule_time
  }

  if ('enabled' in source) {
    if (typeof source.enabled !== 'boolean') return { error: '有効状態が不正です' }
    data.enabled = source.enabled
  } else if (!partial) {
    data.enabled = true
  }

  if (partial && Object.keys(data).length === 0) return { error: '更新項目がありません' }
  return { data }
}

export async function validateOwnedScheduleReferences(
  db: SupabaseClient,
  userId: string,
  input: AutoExtractionScheduleInput,
) {
  const references = [
    ['seller_account_id', 'seller_accounts'],
    ['category_id', 'listing_categories'],
    ['bulk_edit_setting_id', 'bulk_edit_settings'],
  ] as const

  for (const [key, table] of references) {
    const id = input[key]
    if (!id) continue
    const { data, error } = await db.from(table)
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) return { error: error.message, status: 500 }
    if (!data) return { error: '指定された関連設定が見つかりません', status: 400 }
  }
  return null
}
