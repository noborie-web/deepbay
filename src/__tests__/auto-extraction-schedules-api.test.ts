import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

interface QueryState {
  table: string
  operation: 'select' | 'insert' | 'update' | 'delete' | null
  payload?: unknown
  filters: Array<[string, unknown]>
}

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createServiceClient,
}))

import { GET, POST } from '@/app/api/auto-extraction-schedules/route'
import { DELETE, PATCH } from '@/app/api/auto-extraction-schedules/[id]/route'

function makeDatabase(
  resolver: (state: QueryState) => { data: unknown; error: { message: string } | null },
  calls: QueryState[],
) {
  return {
    from(table: string) {
      const state: QueryState = { table, operation: null, filters: [] }
      const finish = () => {
        calls.push({ ...state, filters: [...state.filters] })
        return Promise.resolve(resolver(state))
      }
      const query = {
        select() { if (!state.operation) state.operation = 'select'; return query },
        insert(payload: unknown) { state.operation = 'insert'; state.payload = payload; return query },
        update(payload: unknown) { state.operation = 'update'; state.payload = payload; return query },
        delete() { state.operation = 'delete'; return query },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return query },
        order() { return query },
        limit() { return query },
        single: finish,
        maybeSingle: finish,
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          return finish().then(onFulfilled, onRejected)
        },
      }
      return query
    },
  }
}

function request(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/auto-extraction-schedules', {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const schedule = {
  id: 'schedule-1',
  user_id: 'user-1',
  name: '月次抽出',
  source_url: 'https://example.com/search',
  seller_account_id: null,
  category_id: null,
  bulk_edit_setting_id: null,
  process_type: 'extract',
  schedule_day_of_month: 5,
  schedule_time: '09:00',
  enabled: true,
  created_at: '2026-08-23T00:00:00.000Z',
  updated_at: '2026-08-23T00:00:00.000Z',
}

describe('auto extraction schedules API', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('returns only schedules scoped to the authenticated user', async () => {
    const calls: QueryState[] = []
    const latestRun = {
      id: 'run-1',
      extraction_id: 'extraction-1',
      status: 'completed',
      result_summary: { extracted: 3 },
      error_message: null,
      created_at: '2026-08-24T00:00:00.000Z',
      finished_at: '2026-08-24T00:01:00.000Z',
    }
    mocks.createServiceClient.mockReturnValue(makeDatabase(state => {
      if (state.table === 'auto_extraction_schedules') return { data: [schedule], error: null }
      if (state.table === 'auto_extraction_runs') return { data: latestRun, error: null }
      throw new Error(`Unexpected table: ${state.table}`)
    }, calls))

    const response = await GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ schedules: [{ ...schedule, latest_run: latestRun }] })
    expect(calls[0].filters).toContainEqual(['user_id', 'user-1'])
    expect(calls[1].filters).toEqual(expect.arrayContaining([
      ['schedule_id', 'schedule-1'],
      ['user_id', 'user-1'],
    ]))
  })

  it('creates a schedule with the authenticated user id', async () => {
    const calls: QueryState[] = []
    mocks.createServiceClient.mockReturnValue(makeDatabase(() => ({ data: schedule, error: null }), calls))

    const response = await POST(request('POST', {
      name: '月次抽出',
      source_url: 'https://example.com/search',
      seller_account_id: null,
      category_id: null,
      bulk_edit_setting_id: null,
      process_type: 'extract',
      schedule_day_of_month: 5,
      schedule_time: '09:00',
    }))

    expect(response.status).toBe(201)
    const insert = calls.find(call => call.operation === 'insert')
    expect(insert?.payload).toMatchObject({ user_id: 'user-1', source_url: 'https://example.com/search' })
  })

  it('cannot update another user schedule', async () => {
    const calls: QueryState[] = []
    mocks.createServiceClient.mockReturnValue(makeDatabase(() => ({ data: null, error: null }), calls))

    const response = await PATCH(
      request('PATCH', { enabled: false }),
      { params: Promise.resolve({ id: 'other-user-schedule' }) },
    )

    expect(response.status).toBe(404)
    expect(calls[0].filters).toEqual(expect.arrayContaining([
      ['id', 'other-user-schedule'],
      ['user_id', 'user-1'],
    ]))
  })

  it('cannot delete another user schedule', async () => {
    const calls: QueryState[] = []
    mocks.createServiceClient.mockReturnValue(makeDatabase(() => ({ data: null, error: null }), calls))

    const response = await DELETE(
      request('DELETE'),
      { params: Promise.resolve({ id: 'other-user-schedule' }) },
    )

    expect(response.status).toBe(404)
    expect(calls[0].filters).toEqual(expect.arrayContaining([
      ['id', 'other-user-schedule'],
      ['user_id', 'user-1'],
    ]))
  })

  it('declares RLS read/write checks for the owning user', () => {
    const sql = readFileSync(resolve('supabase/migrations/20260823_auto_extraction_schedules.sql'), 'utf8')
    expect(sql).toContain('ALTER TABLE auto_extraction_schedules ENABLE ROW LEVEL SECURITY')
    expect(sql).toMatch(/USING \(auth\.uid\(\) = user_id\)/)
    expect(sql).toMatch(/WITH CHECK \(auth\.uid\(\) = user_id\)/)
  })
})
