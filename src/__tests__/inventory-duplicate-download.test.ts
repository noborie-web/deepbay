import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let mockUser: { id: string; email?: string } | null = { id: 'user-1', email: 'seller@example.com' }
const mockAdminClient = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: mockUser } })),
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mockAdminClient,
}))

describe('POST /api/inventory/runs/download duplicate CSV', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1', email: 'seller@example.com' }
    mockAdminClient.mockReset()
  })

  const request = (body: unknown) => new NextRequest('http://localhost/api/inventory/runs/download', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  it('returns 401 when not authenticated', async () => {
    mockUser = null
    const { POST } = await import('@/app/api/inventory/runs/download/route')
    const res = await POST(request({ file_type: 'duplicate', duplicate_items: [] }))

    expect(res.status).toBe(401)
  })

  it('uses the duplicate check result for both URL and title matches', async () => {
    const { POST } = await import('@/app/api/inventory/runs/download/route')
    const res = await POST(request({
      file_type: 'duplicate',
      duplicate_items: [
        { ebay_item_id: 'url-item', reason: 'duplicate_url' },
        { ebay_item_id: 'title-item', reason: 'duplicate_title' },
      ],
    }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.filename).toMatch(/^seller_duplicate_\d{8}\.csv$/)
    expect(json.csv).toContain('"End","url-item","NotAvailable","","seller","duplicate_url"')
    expect(json.csv).toContain('"End","title-item","NotAvailable","","seller","duplicate_title"')
    expect(mockAdminClient).not.toHaveBeenCalled()
  })

  it('ignores invalid and duplicate item IDs', async () => {
    const { POST } = await import('@/app/api/inventory/runs/download/route')
    const res = await POST(request({
      file_type: 'duplicate',
      duplicate_items: [
        { ebay_item_id: ' item-1 ', reason: 'duplicate_title' },
        { ebay_item_id: 'item-1', reason: 'duplicate_url' },
        { ebay_item_id: '', reason: 'duplicate_url' },
        null,
      ],
    }))
    const json = await res.json()

    expect(json.csv.match(/"End","item-1"/g)).toHaveLength(1)
    expect(json.csv).toContain('"duplicate_title"')
  })
})
