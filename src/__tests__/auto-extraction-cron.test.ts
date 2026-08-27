import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface QueryState {
  table: string
  operation: 'select' | 'insert' | null
  payload?: Record<string, unknown>
  filters: Array<[string, unknown]>
  selectOptions?: { count?: string; head?: boolean }
}

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  findScraper: vi.fn(),
  runScrape: vi.fn(),
  getDirectListingIssues: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createServiceClient,
}))

vi.mock('@/lib/scrapers', () => ({
  findScraper: mocks.findScraper,
}))

vi.mock('@/lib/extraction-run', () => ({
  runScrape: mocks.runScrape,
}))

vi.mock('@/lib/listing-export', () => ({
  getDirectListingIssues: mocks.getDirectListingIssues,
}))

import { GET } from '@/app/api/cron/auto-extraction/route'

const todaySchedule = {
  id: 'schedule-today',
  user_id: 'user-1',
  name: '本日分',
  source_url: 'https://jp.mercari.com/search?keyword=guitar',
  seller_account_id: 'seller-1',
  category_id: 'category-1',
  bulk_edit_setting_id: 'bulk-1',
  process_type: 'extract_and_list',
  schedule_day_of_month: 24,
}

const otherDaySchedule = {
  ...todaySchedule,
  id: 'schedule-other-day',
  schedule_day_of_month: 25,
}

function makeDatabase(options: {
  schedules?: typeof todaySchedule[]
  profiles?: Record<string, { extraction_limit: number; extraction_used: number }>
  products?: Array<Record<string, unknown>>
  fallbackCategoryId?: string | null
}) {
  const calls: QueryState[] = []
  let extractionCount = 0

  function resolveQuery(state: QueryState) {
    calls.push({ ...state, filters: [...state.filters] })
    if (state.table === 'auto_extraction_schedules') {
      const enabled = state.filters.find(([key]) => key === 'enabled')?.[1]
      const day = state.filters.find(([key]) => key === 'schedule_day_of_month')?.[1]
      return {
        data: (options.schedules ?? []).filter(schedule =>
          enabled === true && schedule.schedule_day_of_month === day),
        error: null,
      }
    }
    if (state.table === 'profiles') {
      const userId = String(state.filters.find(([key]) => key === 'id')?.[1])
      const profile = options.profiles?.[userId] ?? null
      return { data: profile, error: profile ? null : { message: 'Profile not found' } }
    }
    if (state.table === 'extractions') {
      extractionCount += 1
      return { data: { id: `extraction-${extractionCount}` }, error: null }
    }
    if (state.table === 'products') {
      if (state.selectOptions?.head) {
        return { data: null, error: null, count: (options.products ?? []).length }
      }
      return { data: options.products ?? [], error: null }
    }
    if (state.table === 'listing_categories') {
      return {
        data: options.fallbackCategoryId == null
          ? null
          : { ebay_category_id: options.fallbackCategoryId },
        error: null,
      }
    }
    if (state.table === 'auto_extraction_runs') {
      return { data: null, error: null }
    }
    throw new Error(`Unexpected table: ${state.table}`)
  }

  const db = {
    from(table: string) {
      const state: QueryState = { table, operation: null, filters: [] }
      const finish = () => Promise.resolve(resolveQuery(state))
      const query = {
        select(_columns?: string, selectOptions?: { count?: string; head?: boolean }) {
          if (!state.operation) state.operation = 'select'
          state.selectOptions = selectOptions
          return query
        },
        insert(payload: Record<string, unknown>) {
          state.operation = 'insert'
          state.payload = payload
          if (table === 'auto_extraction_runs') return finish()
          return query
        },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
        single: finish,
        maybeSingle: finish,
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          return finish().then(onFulfilled, onRejected)
        },
      }
      return query
    },
  }

  return { db, calls }
}

function request(token = 'cron-secret') {
  return new NextRequest('http://localhost/api/cron/auto-extraction', {
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /api/cron/auto-extraction', () => {
  const originalSecret = process.env.CRON_SECRET

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    process.env.CRON_SECRET = 'cron-secret'
    mocks.createServiceClient.mockReset()
    mocks.findScraper.mockReset().mockReturnValue({ siteKey: 'mercari' })
    mocks.runScrape.mockReset().mockResolvedValue({ status: 'completed' })
    mocks.getDirectListingIssues.mockReset().mockImplementation((product: Record<string, unknown>, fallbackCategoryId: string | null) => {
      const issues: string[] = []
      if (!product.ebay_title) issues.push('タイトル')
      if (!product.ebay_price) issues.push('価格')
      if (!Array.isArray(product.ebay_images) || product.ebay_images.length === 0) issues.push('画像')
      if (!product.ebay_category_id && !fallbackCategoryId) issues.push('カテゴリ')
      return issues
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    process.env.CRON_SECRET = originalSecret
  })

  it.each([
    ['missing secret', undefined, request()],
    ['missing header', 'cron-secret', new NextRequest('http://localhost/api/cron/auto-extraction')],
    ['invalid token', 'cron-secret', request('wrong-secret')],
  ])('returns 401 for %s', async (_case, secret, req) => {
    process.env.CRON_SECRET = secret
    const response = await GET(req)
    expect(response.status).toBe(401)
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('executes only enabled schedules whose day matches today in JST', async () => {
    const { db, calls } = makeDatabase({
      schedules: [todaySchedule, otherDaySchedule],
      profiles: { 'user-1': { extraction_limit: 10, extraction_used: 2 } },
      products: [
        { id: 'ready', ebay_title: 'Ready', ebay_price: 100, ebay_images: ['image.jpg'], ebay_category_id: null },
        { id: 'no-price', ebay_title: 'No price', ebay_price: null, ebay_images: ['image.jpg'], ebay_category_id: null },
        { id: 'no-image', ebay_title: 'No image', ebay_price: 100, ebay_images: [], ebay_category_id: null },
      ],
      fallbackCategoryId: '619',
    })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET(request())
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json).toMatchObject({ ok: true, date_jst: 24, processed: 1 })
    expect(mocks.runScrape).toHaveBeenCalledOnce()
    expect(mocks.runScrape).toHaveBeenCalledWith(
      'user-1',
      'extraction-1',
      todaySchedule.source_url,
      'bulk-1',
      db,
    )
    expect(calls.find(call => call.table === 'auto_extraction_schedules')?.filters).toEqual(expect.arrayContaining([
      ['enabled', true],
      ['schedule_day_of_month', 24],
    ]))
    expect(calls.filter(call => call.table === 'extractions')).toHaveLength(1)
    expect(calls.find(call => call.table === 'extractions')?.payload).toMatchObject({
      user_id: 'user-1',
      source_site: 'mercari',
      status: 'processing',
    })
    expect(calls.find(call => call.table === 'auto_extraction_runs')?.payload).toMatchObject({
      schedule_id: 'schedule-today',
      extraction_id: 'extraction-1',
      status: 'completed',
      result_summary: { extracted: 3, ready_to_list: 1, needs_fix: 2 },
    })
    expect(json.results[0].result_summary).toEqual({ extracted: 3, ready_to_list: 1, needs_fix: 2 })
    expect(mocks.getDirectListingIssues).toHaveBeenCalledTimes(3)
    expect(mocks.getDirectListingIssues).toHaveBeenCalledWith(expect.objectContaining({ id: 'ready' }), '619')
  })

  it('records only the extracted count for extract-only schedules without listing validation', async () => {
    const extractOnlySchedule = { ...todaySchedule, process_type: 'extract' as const }
    const { db, calls } = makeDatabase({
      schedules: [extractOnlySchedule],
      profiles: { 'user-1': { extraction_limit: 10, extraction_used: 2 } },
      products: [{ id: 'product-1' }, { id: 'product-2' }],
    })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET(request())
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.results[0].result_summary).toEqual({ extracted: 2 })
    expect(mocks.getDirectListingIssues).not.toHaveBeenCalled()
    expect(calls.some(call => call.table === 'listing_categories')).toBe(false)
    expect(calls.find(call => call.table === 'auto_extraction_runs')?.payload).toMatchObject({
      result_summary: { extracted: 2 },
    })
  })

  it('skips schedules for users who reached the extraction limit', async () => {
    const { db, calls } = makeDatabase({
      schedules: [todaySchedule],
      profiles: { 'user-1': { extraction_limit: 3, extraction_used: 3 } },
    })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET(request())
    const json = await response.json()

    expect(json.results).toEqual([expect.objectContaining({
      schedule_id: 'schedule-today',
      status: 'skipped',
    })])
    expect(mocks.runScrape).not.toHaveBeenCalled()
    expect(calls.filter(call => call.table === 'extractions')).toHaveLength(0)
    expect(calls.find(call => call.table === 'auto_extraction_runs')?.payload).toMatchObject({
      schedule_id: 'schedule-today',
      status: 'skipped',
    })
  })

  it('is configured for one daily invocation at midnight UTC', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))
    expect(config.crons).toContainEqual({
      path: '/api/cron/auto-extraction',
      schedule: '0 0 * * *',
    })
  })

  it('adds a JSONB result summary column to automatic extraction runs', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20260825_auto_extraction_runs_result_summary.sql'),
      'utf8',
    )
    expect(sql).toMatch(/ALTER TABLE auto_extraction_runs[\s\S]*ADD COLUMN IF NOT EXISTS result_summary jsonb/i)
  })
})
