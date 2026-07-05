import { NextRequest, NextResponse } from 'next/server'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Referer': 'https://snkrdunk.com/',
  'Origin': 'https://snkrdunk.com',
}

const BASE = 'https://snkrdunk.com/v3/search'
const KW = 'ダウンジャケット'

const POST_BODIES = [
  { keywords: KW, searchCategoryIds: ['2/38'], minPrice: 5000, maxPrice: 50000, isSaleOnly: true, page: 1 },
  { keyword: KW, searchCategoryIds: ['2/38'], minPrice: 5000, maxPrice: 50000, page: 1 },
  { keywords: KW, categoryIds: ['2/38'], minPrice: 5000, maxPrice: 50000, page: 1 },
  { keywords: KW, page: 1 },
  { keyword: KW, page: 1 },
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
    POST_BODIES.map(async (body) => {
      const key = JSON.stringify(body)
      try {
        const res = await fetch(BASE, {
          method: 'POST',
          headers: { ...HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        })
        const text = await res.text()
        results[key] = { status: res.status, preview: text.slice(0, 500) }
      } catch (err) {
        results[key] = { status: 0, preview: String(err) }
      }
    })
  )

  return NextResponse.json(results)
}
