import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  findScraper: vi.fn(),
  runScrape: vi.fn(),
}))

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, after: mocks.after }
})

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))
vi.mock('@/lib/scrapers', () => ({ findScraper: mocks.findScraper }))
vi.mock('@/lib/extraction-run', () => ({ runScrape: mocks.runScrape }))

import { POST } from '@/app/api/extract/route'

describe('POST /api/extract regression after runScrape extraction', () => {
  let backgroundTask: Promise<void> | undefined

  beforeEach(() => {
    backgroundTask = undefined
    mocks.after.mockReset().mockImplementation((callback: () => Promise<void>) => {
      backgroundTask = callback()
    })
    mocks.findScraper.mockReset().mockReturnValue({ siteKey: 'mercari' })
    mocks.runScrape.mockReset().mockResolvedValue({ status: 'completed' })

    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      single: vi.fn(),
    }
    query.single
      .mockResolvedValueOnce({ data: { extraction_limit: 10, extraction_used: 2 } })
      .mockResolvedValueOnce({ data: { id: 'extraction-1' }, error: null })

    mocks.createClient.mockReset().mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
      from: vi.fn(() => query),
    })
    mocks.createServiceClient.mockReset().mockReturnValue({ service: true })
  })

  it('keeps the response and delegates the background scrape with the same arguments', async () => {
    const response = await POST(new NextRequest('http://localhost/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://jp.mercari.com/search?keyword=guitar',
        sellerAccountId: 'seller-1',
        categoryId: 'category-1',
        bulkEditSettingId: 'bulk-1',
        memo: '手動抽出',
        isBulk: true,
      }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ extractionId: 'extraction-1' })
    await backgroundTask
    expect(mocks.runScrape).toHaveBeenCalledWith(
      'user-1',
      'extraction-1',
      'https://jp.mercari.com/search?keyword=guitar',
      'bulk-1',
      { service: true },
    )
  })
})
