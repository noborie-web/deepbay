import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

describe('POST /api/admin/import-ebay-categories', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejects requests when ADMIN_API_SECRET is not configured', async () => {
    vi.stubEnv('ADMIN_API_SECRET', '')
    const { POST } = await import('@/app/api/admin/import-ebay-categories/route')
    const response = await POST(new NextRequest('http://localhost/api/admin/import-ebay-categories', {
      method: 'POST',
      headers: { authorization: 'Bearer undefined' },
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('rejects an invalid Bearer token', async () => {
    vi.stubEnv('ADMIN_API_SECRET', 'admin-secret')
    const { POST } = await import('@/app/api/admin/import-ebay-categories/route')
    const response = await POST(new NextRequest('http://localhost/api/admin/import-ebay-categories', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret' },
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('rejects a request without an Authorization header', async () => {
    vi.stubEnv('ADMIN_API_SECRET', 'admin-secret')
    const { POST } = await import('@/app/api/admin/import-ebay-categories/route')
    const response = await POST(new NextRequest('http://localhost/api/admin/import-ebay-categories', {
      method: 'POST',
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })
})
