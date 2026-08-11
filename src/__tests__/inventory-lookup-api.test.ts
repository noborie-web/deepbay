import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let mockUser: { id: string } | null = { id: 'user-1' }
let mockLookupData: Record<string, unknown> | null = null
let mockLookupError: { message: string } | null = null
const mockEq = vi.fn()
const mockMaybeSingle = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockUser } })),
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: mockEq.mockReturnThis(),
      maybeSingle: mockMaybeSingle,
    })),
  })),
}))

describe('GET /api/inventory/lookup', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1' }
    mockLookupData = null
    mockLookupError = null
    mockEq.mockClear()
    mockMaybeSingle.mockReset().mockImplementation(async () => ({
      data: mockLookupData,
      error: mockLookupError,
    }))
  })

  const request = (code?: string) => new NextRequest(
    `http://localhost/api/inventory/lookup${code === undefined ? '' : `?code=${encodeURIComponent(code)}`}`,
  )

  it('returns 401 when not authenticated', async () => {
    mockUser = null
    const { GET } = await import('@/app/api/inventory/lookup/route')
    const res = await GET(request('item-code'))

    expect(res.status).toBe(401)
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  it('returns 400 when the code is missing or blank', async () => {
    const { GET } = await import('@/app/api/inventory/lookup/route')
    const missingRes = await GET(request())
    const blankRes = await GET(request('   '))

    expect(missingRes.status).toBe(400)
    expect(blankRes.status).toBe(400)
    expect(mockMaybeSingle).not.toHaveBeenCalled()
  })

  it('returns found=false when no product matches', async () => {
    const { GET } = await import('@/app/api/inventory/lookup/route')
    const res = await GET(request('missing-code'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ found: false, source_url: null })
    expect(mockEq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(mockEq).toHaveBeenCalledWith('source_item_id', 'missing-code')
  })

  it('returns the source URL and title for a matching product', async () => {
    mockLookupData = {
      id: 'product-1',
      source_url: 'https://example.com/item/1',
      original_title: 'Example item',
      source_item_id: 'item-code',
    }
    const { GET } = await import('@/app/api/inventory/lookup/route')
    const res = await GET(request('item-code'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      found: true,
      source_url: 'https://example.com/item/1',
      title: 'Example item',
      product_id: 'product-1',
    })
  })

  it('extracts an embedded DBK-ID before searching', async () => {
    const dbkId = 'ele_20260802_abc123de_f456_7890_abcd_ef1234567890'
    const { GET } = await import('@/app/api/inventory/lookup/route')
    await GET(request(`prefix_${dbkId}_suffix`))

    expect(mockEq).toHaveBeenCalledWith('source_item_id', dbkId)
  })

  it('returns 500 when the database lookup fails', async () => {
    mockLookupError = { message: 'database unavailable' }
    const { GET } = await import('@/app/api/inventory/lookup/route')
    const res = await GET(request('item-code'))
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json).toEqual({ error: 'database unavailable' })
  })
})
