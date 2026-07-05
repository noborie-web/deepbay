import { NextRequest, NextResponse } from 'next/server'

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Referer': 'https://snkrdunk.com/',
  'Origin': 'https://snkrdunk.com',
}

// Various endpoint patterns to try for snkrdunk search API
const ENDPOINTS = [
  (params: URLSearchParams) => `https://snkrdunk.com/v3/search?${params}`,
  (params: URLSearchParams) => `https://snkrdunk.com/v1/search?${params}`,
  (params: URLSearchParams) => `https://snkrdunk.com/v1/apparel/used/listings?${params}`,
  (params: URLSearchParams) => `https://snkrdunk.com/v3/apparel/used/listings?${params}`,
  (params: URLSearchParams) => `https://snkrdunk.com/v3/apparel/used/search?${params}`,
  (params: URLSearchParams) => `https://snkrdunk.com/v1/apparel/used/search?${params}`,
]

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { token, cookie, keyword, categoryIds, minPrice, maxPrice, page = 1 } = body

  const headers: Record<string, string> = { ...BASE_HEADERS }
  if (token) headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`
  if (cookie) headers['Cookie'] = cookie

  // Try multiple param combinations for /v3/search
  const paramSets: URLSearchParams[] = []

  const base1 = new URLSearchParams()
  if (keyword) base1.set('keyword', keyword)
  base1.set('page', String(page))
  base1.set('limit', '30')
  paramSets.push(base1)

  const base2 = new URLSearchParams()
  if (keyword) base2.set('keywords', keyword)
  base2.set('page', String(page))
  base2.set('limit', '30')
  paramSets.push(base2)

  const base3 = new URLSearchParams()
  if (keyword) base3.set('keyword', keyword)
  if (minPrice) base3.set('minPrice', String(minPrice))
  if (maxPrice) base3.set('maxPrice', String(maxPrice))
  base3.set('isSaleOnly', 'true')
  base3.set('page', String(page))
  base3.set('limit', '30')
  paramSets.push(base3)

  const base4 = new URLSearchParams()
  if (keyword) base4.set('keywords', keyword)
  if (categoryIds) base4.set('categoryId', categoryIds)
  if (minPrice) base4.set('minPrice', String(minPrice))
  if (maxPrice) base4.set('maxPrice', String(maxPrice))
  base4.set('page', String(page))
  base4.set('limit', '30')
  paramSets.push(base4)

  const results: Array<{ url: string; status: number; preview: string; itemCount?: number }> = []

  for (const params of paramSets) {
    const url = `https://snkrdunk.com/v3/search?${params}`
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      const text = await res.text()
      let itemCount: number | undefined
      try {
        const json = JSON.parse(text)
        const arr = json?.data?.listings ?? json?.data?.items ?? json?.listings ?? json?.items ?? json?.data
        if (Array.isArray(arr)) itemCount = arr.length
      } catch { /* not JSON */ }
      results.push({ url, status: res.status, preview: text.slice(0, 500), itemCount })
    } catch (err) {
      results.push({ url, status: 0, preview: String(err) })
    }
  }

  return NextResponse.json({ results })
}
