import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { DELETE, GET, POST } from '@/app/api/bulk-edit-danger-sellers/route'

function makeDatabase(options: {
  ownsSetting?: boolean
  sellers?: Array<{ id: string; seller_url: string }>
  insertedSeller?: { id: string; seller_url: string } | null
  deleteCount?: number
} = {}) {
  const ownsSetting = options.ownsSetting ?? true
  const calls: Array<{ table: string; op: string }> = []
  return {
    calls,
    db: {
      from(table: string) {
        let operation: 'delete' | null = null
        const query = {
          select() { return query },
          eq() { return query },
          order() {
            calls.push({ table, op: 'list' })
            return Promise.resolve({ data: options.sellers ?? [], error: null })
          },
          maybeSingle() {
            calls.push({ table, op: 'ownership-check' })
            return Promise.resolve({ data: ownsSetting ? { id: 'bulk-1' } : null, error: null })
          },
          insert() {
            calls.push({ table, op: 'insert' })
            return query
          },
          single() {
            return Promise.resolve({ data: options.insertedSeller ?? null, error: null })
          },
          delete() {
            calls.push({ table, op: 'delete' })
            operation = 'delete'
            return query
          },
          then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
            const value = operation === 'delete' ? { error: null, count: options.deleteCount ?? 1 } : { data: null, error: null }
            return Promise.resolve(value).then(onFulfilled, onRejected)
          },
        }
        return query
      },
    },
  }
}

describe('bulk edit danger sellers API', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('GET returns the sellers scoped to the owned bulk edit setting', async () => {
    const sellers = [{ id: 's1', seller_url: 'https://jp.mercari.com/user/profile/999' }]
    const { db } = makeDatabase({ sellers })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET(new NextRequest('http://localhost/api/bulk-edit-danger-sellers?bulk_edit_setting_id=bulk-1'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.sellers).toEqual(sellers)
  })

  it('GET returns 404 when the setting is not owned by the authenticated user', async () => {
    const { db } = makeDatabase({ ownsSetting: false })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await GET(new NextRequest('http://localhost/api/bulk-edit-danger-sellers?bulk_edit_setting_id=bulk-1'))

    expect(response.status).toBe(404)
  })

  it('POST adds a seller URL to the owned setting', async () => {
    const inserted = { id: 's2', seller_url: 'https://jp.mercari.com/user/profile/111' }
    const { db } = makeDatabase({ insertedSeller: inserted })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await POST(new NextRequest('http://localhost/api/bulk-edit-danger-sellers', {
      method: 'POST',
      body: JSON.stringify({ bulk_edit_setting_id: 'bulk-1', seller_url: 'https://jp.mercari.com/user/profile/111' }),
    }))

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.seller).toEqual(inserted)
  })

  it('POST rejects when the setting is not owned by the authenticated user', async () => {
    const { db } = makeDatabase({ ownsSetting: false })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await POST(new NextRequest('http://localhost/api/bulk-edit-danger-sellers', {
      method: 'POST',
      body: JSON.stringify({ bulk_edit_setting_id: 'not-mine', seller_url: 'https://jp.mercari.com/user/profile/111' }),
    }))

    expect(response.status).toBe(404)
  })

  it('DELETE removes a seller row owned by the authenticated user', async () => {
    const { db } = makeDatabase({ deleteCount: 1 })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await DELETE(new NextRequest('http://localhost/api/bulk-edit-danger-sellers?id=s1', { method: 'DELETE' }))

    expect(response.status).toBe(200)
  })

  it('DELETE returns 404 when nothing owned by the user matched', async () => {
    const { db } = makeDatabase({ deleteCount: 0 })
    mocks.createServiceClient.mockReturnValue(db)

    const response = await DELETE(new NextRequest('http://localhost/api/bulk-edit-danger-sellers?id=not-mine', { method: 'DELETE' }))

    expect(response.status).toBe(404)
  })
})
