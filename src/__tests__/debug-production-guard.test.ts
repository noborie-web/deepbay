import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

describe('production debug route guards', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['/api/debug-fetch', '@/app/api/debug-fetch/route'],
    ['/api/debug-snkr', '@/app/api/debug-snkr/route'],
    ['/api/test-scrape', '@/app/api/test-scrape/route'],
  ])('returns 404 from GET %s', async (path, modulePath) => {
    vi.stubEnv('NODE_ENV', 'production')
    const route = await import(modulePath) as { GET: (req: NextRequest) => Promise<Response> }
    const response = await route.GET(new NextRequest(`http://localhost${path}`))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
  })

  it('returns 404 from POST /api/snkr-search', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { POST } = await import('@/app/api/snkr-search/route')
    const response = await POST(new NextRequest('http://localhost/api/snkr-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
  })
})
