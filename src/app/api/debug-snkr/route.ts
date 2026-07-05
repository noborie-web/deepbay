import { NextRequest, NextResponse } from 'next/server'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Referer': 'https://snkrdunk.com/',
  'Origin': 'https://snkrdunk.com',
}

const SEARCH_PARAMS = 'keywords=%E3%83%80%E3%82%A6%E3%83%B3%E3%82%B8%E3%83%A3%E3%82%B1%E3%83%83%E3%83%88&searchCategoryIds=2%2F38&minPrice=5000&maxPrice=50000&isSaleOnly=true&page=1&limit=30'

const ENDPOINTS = [
  `https://snkrdunk.com/v3/search/apparel/used?${SEARCH_PARAMS}`,
  `https://snkrdunk.com/v3/apparel/used/search?${SEARCH_PARAMS}`,
  `https://snkrdunk.com/v3/search?${SEARCH_PARAMS}`,
  `https://snkrdunk.com/v3/apparel/used?${SEARCH_PARAMS}`,
  `https://snkrdunk.com/api/v3/search?${SEARCH_PARAMS}`,
  `https://snkrdunk.com/api/search?${SEARCH_PARAMS}`,
  `https://snkrdunk.com/v3/search/used?${SEARCH_PARAMS}`,
  `https://api.snkrdunk.com/v3/search?${SEARCH_PARAMS}`,
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
