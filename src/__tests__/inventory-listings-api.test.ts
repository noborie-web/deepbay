import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let mockUser: { id: string } | null = { id: 'user-1' }

const {
  mockSelect,
  mockEq,
  mockOr,
  mockOrder,
  mockRange,
  mockIs,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockEq: vi.fn(),
  mockOr: vi.fn(),
  mockOrder: vi.fn(),
  mockRange: vi.fn(),
  mockIs: vi.fn(),
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
    from: vi.fn(() => ({
      select: mockSelect.mockReturnThis(),
      eq: mockEq.mockReturnThis(),
      or: mockOr.mockReturnThis(),
      order: mockOrder.mockReturnThis(),
      range: mockRange,
      is: mockIs,
    })),
  })),
}))

describe('GET /api/inventory/listings', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1' }
    mockSelect.mockClear()
    mockEq.mockClear()
    mockOr.mockClear()
    mockOrder.mockClear()
    mockRange.mockReset().mockResolvedValue({
      data: [{ id: 'listing-1', ebay_item_id: '123', title: 'Camera' }],
      error: null,
      count: 123,
    })
    mockIs.mockReset().mockResolvedValue({ count: 7, error: null })
  })

  const request = (query = '') => new NextRequest(`http://localhost/api/inventory/listings${query}`)

  it('returns 401 when not authenticated', async () => {
    mockUser = null
    const { GET } = await import('@/app/api/inventory/listings/route')
    const res = await GET(request())

    expect(res.status).toBe(401)
    expect(mockRange).not.toHaveBeenCalled()
  })

  it('returns a 50-item page with the exact total', async () => {
    const { GET } = await import('@/app/api/inventory/listings/route')
    const res = await GET(request('?page=2'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(mockSelect).toHaveBeenCalledWith('*', { count: 'exact' })
    expect(mockEq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(mockOrder).toHaveBeenCalledWith('fetched_at', { ascending: false })
    expect(mockRange).toHaveBeenCalledWith(50, 99)
    expect(mockSelect).toHaveBeenCalledWith('id', { count: 'exact', head: true })
    expect(mockIs).toHaveBeenCalledWith('product_id', null)
    expect(json).toEqual({
      listings: [{ id: 'listing-1', ebay_item_id: '123', title: 'Camera' }],
      total: 123,
      unmatchedTotal: 7,
      page: 2,
      pageSize: 50,
      totalPages: 3,
    })
  })

  it('reports the unmatched total across all pages, independent of the current page size', async () => {
    mockIs.mockResolvedValue({ count: 512, error: null })
    const { GET } = await import('@/app/api/inventory/listings/route')
    const res = await GET(request('?page=1'))
    const json = await res.json()

    // The unmatched total (512) exceeds a single page's worth of listings
    // (max 50 rows), proving it is a real aggregate and not just the count
    // of unmatched rows within the currently loaded page.
    expect(json.unmatchedTotal).toBe(512)
    expect(json.listings.length).toBeLessThanOrEqual(50)
  })

  it('returns a 500 when the unmatched-count query fails', async () => {
    mockIs.mockResolvedValue({ count: null, error: { message: 'unmatched count unavailable' } })
    const { GET } = await import('@/app/api/inventory/listings/route')
    const res = await GET(request())
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json).toEqual({ error: 'unmatched count unavailable' })
  })

  it('searches item id, title, and custom label while keeping filter syntax out of the value', async () => {
    const { GET } = await import('@/app/api/inventory/listings/route')
    await GET(request('?page=3&q=camera%2C(test)'))

    expect(mockOr).toHaveBeenCalledWith([
      'ebay_item_id.ilike.%camera  test%',
      'title.ilike.%camera  test%',
      'custom_label.ilike.%camera  test%',
    ].join(','))
    expect(mockRange).toHaveBeenCalledWith(100, 149)
  })

  it('falls back to page one and returns database errors', async () => {
    mockRange.mockResolvedValue({ data: null, error: { message: 'database unavailable' }, count: null })
    const { GET } = await import('@/app/api/inventory/listings/route')
    const res = await GET(request('?page=invalid'))
    const json = await res.json()

    expect(mockRange).toHaveBeenCalledWith(0, 49)
    expect(res.status).toBe(500)
    expect(json).toEqual({ error: 'database unavailable' })
  })
})
