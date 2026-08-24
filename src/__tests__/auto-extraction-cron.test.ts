import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface QueryState {
  table: string
  operation: 'select' | 'insert' | null
  payload?: Record<string, unknown>
  filters: Array<[string, unknown]>
}

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  findScraper: vi.fn(),
  runScrape: vi.fn(),
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
        select() { if (!state.operation) state.operation = 'select'; return query },
        insert(payload: Record<string, unknown>) {
          state.operation = 'insert'
          state.payload = payload
          if (table === 'auto_extraction_runs') return finish()
          return query
        },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
        single: finish,
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
})
