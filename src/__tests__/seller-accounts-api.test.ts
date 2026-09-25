import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { DELETE, GET, PATCH, POST } from '@/app/api/seller-accounts/route'

interface DbOptions {
  sellers?: Array<Record<string, unknown>>
  existingSeller?: { id: string } | null
  sellerCount?: number
  target?: { id: string; is_default?: boolean } | null
  extractionCount?: number
  inserted?: Record<string, unknown>
}

function makeDatabase(options: DbOptions = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown }> = []
  const db = {
    from(table: string) {
      let operation: 'select' | 'insert' | 'update' | 'delete' | 'count' = 'select'
      let payload: unknown = null
      const query = {
        select(_columns?: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.count) operation = 'count'
          return query
        },
        eq() { return query },
        order() { return query },
        limit() { return query },
        insert(values: unknown) { operation = 'insert'; payload = values; return query },
        update(values: unknown) { operation = 'update'; payload = values; return query },
        delete() { operation = 'delete'; return query },
        maybeSingle() {
          calls.push({ table, op: 'maybeSingle' })
          if (table === 'seller_accounts' && operation === 'select') {
            // 追加時の重複チェックと、更新/削除時の所有者チェックを兼ねる
            return Promise.resolve({
              data: options.existingSeller !== undefined ? options.existingSeller : (options.target ?? null),
              error: null,
            })
          }
          return Promise.resolve({ data: null, error: null })
        },
        single() {
          calls.push({ table, op: 'single', payload })
          return Promise.resolve({ data: options.inserted ?? { id: 'new-1' }, error: null })
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
          calls.push({ table, op: operation, payload })
          const value = operation === 'count'
            ? { count: table === 'extractions' ? (options.extractionCount ?? 0) : (options.sellerCount ?? 0), error: null }
            : operation === 'select'
              ? { data: options.sellers ?? [], error: null }
              : { data: null, error: null }
          return Promise.resolve(value).then(onFulfilled, onRejected)
        },
      }
      return query
    },
  }
  return { db, calls }
}

function jsonRequest(body: unknown) {
  return new NextRequest('http://localhost/api/seller-accounts', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('seller accounts API', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('GET returns the seller accounts of the signed-in user', async () => {
    const sellers = [{ id: 's1', seller_id: 'miyabi-24', is_default: true }]
    const { db } = makeDatabase({ sellers })
    mocks.createServiceClient.mockReturnValue(db)
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ sellers })
  })

  it('GET rejects unauthenticated requests', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('POST rejects an invalid seller id', async () => {
    const { db } = makeDatabase()
    mocks.createServiceClient.mockReturnValue(db)
    const res = await POST(jsonRequest({ seller_id: 'a b' }))
    expect(res.status).toBe(400)
  })

  it('POST rejects a duplicate seller id', async () => {
    const { db } = makeDatabase({ existingSeller: { id: 's1' } })
    mocks.createServiceClient.mockReturnValue(db)
    const res = await POST(jsonRequest({ seller_id: 'miyabi-24' }))
    expect(res.status).toBe(409)
  })

  it('POST makes the first seller account the default', async () => {
    const { db, calls } = makeDatabase({ existingSeller: null, sellerCount: 0 })
    mocks.createServiceClient.mockReturnValue(db)
    const res = await POST(jsonRequest({ seller_id: 'miyabi-24', display_name: ' メイン ' }))
    expect(res.status).toBe(200)
    const insert = calls.find((c) => c.op === 'single')
    expect(insert?.payload).toMatchObject({
      user_id: 'user-1',
      seller_id: 'miyabi-24',
      display_name: 'メイン',
      is_default: true,
    })
  })

  it('POST does not steal the default flag from an existing account', async () => {
    const { db, calls } = makeDatabase({ existingSeller: null, sellerCount: 2 })
    mocks.createServiceClient.mockReturnValue(db)
    await POST(jsonRequest({ seller_id: 'second-shop' }))
    const insert = calls.find((c) => c.op === 'single')
    expect(insert?.payload).toMatchObject({ is_default: false })
  })

  it('PATCH clears other defaults before setting a new one', async () => {
    const { db, calls } = makeDatabase({ existingSeller: { id: 's2' } })
    mocks.createServiceClient.mockReturnValue(db)
    const res = await PATCH(jsonRequest({ id: 's2', is_default: true }))
    expect(res.status).toBe(200)
    const updates = calls.filter((c) => c.op === 'update')
    expect(updates[0]?.payload).toEqual({ is_default: false })
    expect(updates[1]?.payload).toEqual({ is_default: true })
  })

  it('PATCH rejects an account that belongs to someone else', async () => {
    const { db } = makeDatabase({ existingSeller: null })
    mocks.createServiceClient.mockReturnValue(db)
    const res = await PATCH(jsonRequest({ id: 'other', display_name: 'x' }))
    expect(res.status).toBe(404)
  })

  it('DELETE refuses to remove an account used by extractions', async () => {
    const { db } = makeDatabase({ extractionCount: 3 })
    mocks.createServiceClient.mockReturnValue(db)
    const res = await DELETE(jsonRequest({ id: 's1' }))
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: 'この出品アカウントを使っている抽出が3件あるため削除できません',
    })
  })

  it('DELETE removes an unused account', async () => {
    const { db, calls } = makeDatabase({ extractionCount: 0, existingSeller: { id: 's1' } })
    mocks.createServiceClient.mockReturnValue(db)
    const res = await DELETE(jsonRequest({ id: 's1' }))
    expect(res.status).toBe(200)
    expect(calls.some((c) => c.op === 'delete')).toBe(true)
  })
})
