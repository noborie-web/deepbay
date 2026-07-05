import { NextRequest, NextResponse } from 'next/server'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Referer': 'https://snkrdunk.com/',
  'Origin': 'https://snkrdunk.com',
}

// v3/search exists (400 bad_request) - try different param combos
const BASE = 'https://snkrdunk.com/v3/search'
const KW = encodeURIComponent('ダウンジャケット')

const ENDPOINTS = [
  `${BASE}?keyword=${KW}&categoryId=2%2F38&minPrice=5000&maxPrice=50000&page=1`,
  `${BASE}?keyword=${KW}&searchCategoryId=2%2F38&minPrice=5000&maxPrice=50000&page=1`,
  `${BASE}?q=${KW}&searchCategoryIds=2%2F38&minPrice=5000&maxPrice=50000&page=1`,
  `${BASE}?keywords=${KW}&page=1`,
  `${BASE}?keyword=${KW}&page=1`,
  `${BASE}?keyword=${KW}&type=apparel&page=1`,
  `${BASE}?keyword=${KW}&searchCategoryIds=2%2F38&page=1`,
  `${BASE}?keywords=${KW}&searchCategoryIds=2%2F38&minPrice=5000&maxPrice=50000&page=1`,
]

export async function GET(req: NextRequest) {
  const single = req.nextUrl.searchParams.get('endpoint')

  if (single) {
    const res = await fetch(decodeURIComponent(single), { headers: HEADERS })
    const text = await res.text()
    return NextResponse.json({ status: res.status, preview: text.slice(0, 1000) })
  }

  const results: Record<string, { status: number; preview: string }> = {}

  await Promise.all(
    ENDPOINTS.map(async (endpoint) => {
      try {
        const res = await fetch(endpoint, { headers: HEADERS, signal: AbortSignal.timeout(5000) })
        const text = await res.text()
        results[endpoint] = { status: res.status, preview: text.slice(0, 300) }
      } catch (err) {
        results[endpoint] = { status: 0, preview: String(err) }
      }
    })
  )

  return NextResponse.json(results)
}
