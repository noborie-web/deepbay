// Vercel Cron Job — 毎日0時UTC（9時台JST）に当日分をまとめて実行
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { findScraper } from '@/lib/scrapers'
import { runScrape } from '@/lib/extraction-run'
import { getDirectListingIssues } from '@/lib/listing-export'
import type { Product } from '@/types/database'

export const maxDuration = 300

interface AutoExtractionSchedule {
  id: string
  user_id: string
  name: string | null
  source_url: string
  seller_account_id: string | null
  category_id: string | null
  bulk_edit_setting_id: string | null
  process_type: 'extract' | 'extract_and_list'
  schedule_day_of_month: number
}

interface CronResult {
  schedule_id: string
  extraction_id?: string
  status: 'completed' | 'skipped' | 'failed'
  reason?: string
  result_summary?: AutoExtractionResultSummary
}

interface AutoExtractionResultSummary {
  extracted: number
  ready_to_list?: number
  needs_fix?: number
}

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export function getJstDayOfMonth(date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    day: 'numeric',
  }).format(date))
}

async function recordFinishedRun(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  schedule: AutoExtractionSchedule,
  status: CronResult['status'],
  options: {
    extractionId?: string
    errorMessage?: string
    resultSummary?: AutoExtractionResultSummary
  } = {},
) {
  await db.from('auto_extraction_runs').insert({
    user_id: schedule.user_id,
    schedule_id: schedule.id,
    extraction_id: options.extractionId ?? null,
    status,
    error_message: options.errorMessage ?? null,
    result_summary: options.resultSummary ?? null,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
}

async function summarizeExtraction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  schedule: AutoExtractionSchedule,
  extractionId: string,
): Promise<AutoExtractionResultSummary> {
  if (schedule.process_type === 'extract') {
    const { count, error } = await db
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('extraction_id', extractionId)
      .eq('user_id', schedule.user_id)
    if (error) throw new Error(error.message)
    return { extracted: count ?? 0 }
  }

  const { data: products, error: productsError } = await db
    .from('products')
    .select('*')
    .eq('extraction_id', extractionId)
    .eq('user_id', schedule.user_id)
  if (productsError) throw new Error(productsError.message)

  let fallbackCategoryId: string | null = null
  if (schedule.category_id) {
    const { data: category, error: categoryError } = await db
      .from('listing_categories')
      .select('ebay_category_id')
      .eq('id', schedule.category_id)
      .eq('user_id', schedule.user_id)
      .maybeSingle()
    if (categoryError) throw new Error(categoryError.message)
    fallbackCategoryId = category?.ebay_category_id ?? null
  }

  let readyToList = 0
  let needsFix = 0
  for (const product of (products ?? []) as Product[]) {
    if (getDirectListingIssues(product, fallbackCategoryId).length === 0) readyToList += 1
    else needsFix += 1
  }
  return {
    extracted: (products ?? []).length,
    ready_to_list: readyToList,
    needs_fix: needsFix,
  }
}

async function executeSchedule(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  schedule: AutoExtractionSchedule,
): Promise<CronResult> {
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('extraction_limit, extraction_used')
    .eq('id', schedule.user_id)
    .single()

  if (profileError || !profile) {
    const reason = profileError?.message ?? 'Profile not found'
    await recordFinishedRun(db, schedule, 'failed', { errorMessage: reason })
    return { schedule_id: schedule.id, status: 'failed', reason }
  }

  if (profile.extraction_used >= profile.extraction_limit) {
    const reason = '抽出回数の上限に達しているためスキップしました。'
    await recordFinishedRun(db, schedule, 'skipped', { errorMessage: reason })
    return { schedule_id: schedule.id, status: 'skipped', reason }
  }

  const scraper = findScraper(schedule.source_url)
  if (!scraper) {
    const reason = 'このURLに対応するスクレイパーが見つかりません。'
    await recordFinishedRun(db, schedule, 'failed', { errorMessage: reason })
    return { schedule_id: schedule.id, status: 'failed', reason }
  }

  const { data: extraction, error: insertError } = await db
    .from('extractions')
    .insert({
      user_id: schedule.user_id,
      source_url: schedule.source_url,
      source_site: scraper.siteKey,
      seller_account_id: schedule.seller_account_id,
      category_id: schedule.category_id,
      bulk_edit_setting_id: schedule.bulk_edit_setting_id,
      memo: schedule.name ?? '',
      is_bulk: true,
      status: 'processing',
      progress: 0,
    })
    .select('id')
    .single()

  if (insertError || !extraction) {
    const reason = insertError?.message ?? '抽出ジョブを作成できませんでした。'
    await recordFinishedRun(db, schedule, 'failed', { errorMessage: reason })
    return { schedule_id: schedule.id, status: 'failed', reason }
  }

  // 出品操作は行わず、フェーズ3では抽出完了後の出品準備状態だけを検証する。
  const runResult = await runScrape(
    schedule.user_id,
    extraction.id,
    schedule.source_url,
    schedule.bulk_edit_setting_id,
    db,
  )

  if (runResult.status === 'failed') {
    await recordFinishedRun(db, schedule, 'failed', {
      extractionId: extraction.id,
      errorMessage: runResult.errorMessage,
    })
    return {
      schedule_id: schedule.id,
      extraction_id: extraction.id,
      status: 'failed',
      reason: runResult.errorMessage,
    }
  }

  if (runResult.status === 'excluded') {
    const reason = '危険セラー設定に一致したためスキップしました。'
    await recordFinishedRun(db, schedule, 'skipped', {
      extractionId: extraction.id,
      errorMessage: reason,
    })
    return { schedule_id: schedule.id, extraction_id: extraction.id, status: 'skipped', reason }
  }

  const resultSummary = await summarizeExtraction(db, schedule, extraction.id)
  await recordFinishedRun(db, schedule, 'completed', {
    extractionId: extraction.id,
    resultSummary,
  })
  return {
    schedule_id: schedule.id,
    extraction_id: extraction.id,
    status: 'completed',
    result_summary: resultSummary,
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = admin()
  const today = getJstDayOfMonth()
  const { data: schedules, error } = await db
    .from('auto_extraction_schedules')
    .select('id, user_id, name, source_url, seller_account_id, category_id, bulk_edit_setting_id, process_type, schedule_day_of_month')
    .eq('enabled', true)
    .eq('schedule_day_of_month', today)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const results: CronResult[] = []
  for (const schedule of (schedules ?? []) as AutoExtractionSchedule[]) {
    try {
      results.push(await executeSchedule(db, schedule))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await recordFinishedRun(db, schedule, 'failed', { errorMessage: reason }).catch(() => undefined)
      results.push({ schedule_id: schedule.id, status: 'failed', reason })
    }
  }

  return NextResponse.json({ ok: true, date_jst: today, processed: results.length, results })
}
