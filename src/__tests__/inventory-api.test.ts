import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Supabase mock
// ---------------------------------------------------------------------------
let mockUser: { id: string } | null = { id: 'user-1' }
let mockSettingsData: Record<string, unknown> | null = null
let mockSettingsError: { message: string } | null = null
let mockUpsertError: { message: string } | null = null
const mockHasInventoryAuthentication = vi.fn()

vi.mock('@/lib/inventory-auth', () => ({
  hasInventoryAuthentication: mockHasInventoryAuthentication,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockUser } })),
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_settings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(async () => ({ data: mockSettingsData, error: mockSettingsError })),
          upsert: vi.fn(async () => ({ error: mockUpsertError })),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      }
    }),
  })),
}))

// ---------------------------------------------------------------------------
// /api/inventory/settings GET
// ---------------------------------------------------------------------------
describe('GET /api/inventory/settings', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1' }
    mockSettingsData = null
    mockSettingsError = null
    mockHasInventoryAuthentication.mockReset().mockImplementation(
      async (_db: unknown, _userId: string, token?: string | null) => !!token,
    )
  })

  it('returns 401 when not authenticated', async () => {
    mockUser = null
    const { GET } = await import('@/app/api/inventory/settings/route')
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns has_token=false when no settings exist', async () => {
    const { GET } = await import('@/app/api/inventory/settings/route')
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.settings.has_token).toBe(false)
  })

  it('returns has_token=true when token is set', async () => {
    mockSettingsData = { id: 'x', sync_enabled: true, ebay_token: 'tok', ebay_token_expires_at: null, created_at: '', updated_at: '' }
    const { GET } = await import('@/app/api/inventory/settings/route')
    const res = await GET()
    const json = await res.json()
    expect(json.settings.has_token).toBe(true)
  })

  it('returns has_token=true when one connected seller can authenticate inventory', async () => {
    mockHasInventoryAuthentication.mockResolvedValue(true)
    const { GET } = await import('@/app/api/inventory/settings/route')
    const res = await GET()
    const json = await res.json()

    expect(json.settings.has_token).toBe(true)
    expect(mockHasInventoryAuthentication).toHaveBeenCalledWith(expect.anything(), 'user-1', undefined)
  })
})

// ---------------------------------------------------------------------------
// /api/inventory/settings PUT
// ---------------------------------------------------------------------------
describe('PUT /api/inventory/settings', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1' }
    mockUpsertError = null
  })

  it('returns 401 when not authenticated', async () => {
    mockUser = null
    const { PUT } = await import('@/app/api/inventory/settings/route')
    const req = new NextRequest('http://localhost/api/inventory/settings', {
      method: 'PUT',
      body: JSON.stringify({ sync_enabled: true }),
    })
    const res = await PUT(req)
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid JSON', async () => {
    const { PUT } = await import('@/app/api/inventory/settings/route')
    const req = new NextRequest('http://localhost/api/inventory/settings', {
      method: 'PUT',
      body: 'not json',
    })
    const res = await PUT(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 when no allowed fields provided', async () => {
    const { PUT } = await import('@/app/api/inventory/settings/route')
    const req = new NextRequest('http://localhost/api/inventory/settings', {
      method: 'PUT',
      body: JSON.stringify({ unknown_field: 'value' }),
    })
    const res = await PUT(req)
    expect(res.status).toBe(400)
  })

  it('returns 200 for valid sync_enabled update', async () => {
    const { PUT } = await import('@/app/api/inventory/settings/route')
    const req = new NextRequest('http://localhost/api/inventory/settings', {
      method: 'PUT',
      body: JSON.stringify({ sync_enabled: true }),
    })
    const res = await PUT(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
  })
})
