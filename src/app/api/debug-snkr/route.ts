import { NextRequest, NextResponse } from 'next/server'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Referer': 'https://snkrdunk.com/',
  'Origin': 'https://snkrdunk.com',
}

// Known listing IDs extracted from image preload URLs in search page HTML
const KNOWN_IDS = ['8600542', '7691177', '8009016']

export async function GET(req: NextRequest) {
  const single = req.nextUrl.searchParams.get('endpoint')

  if (single) {
    const res = await fetch(decodeURIComponent(single), { headers: HEADERS })
    const text = await res.text()
    return NextResponse.json({ status: res.status, preview: text.slice(0, 1000) })
  }

  const results: Record<string, { status: number; hasNextData: boolean; hasNextF: boolean; htmlLength: number; dataPreview: string | null }> = {}

  await Promise.all(
    KNOWN_IDS.map(async (id) => {
      const url = `https://snkrdunk.com/apparel/used/${id}`
      try {
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) })
        const html = await res.text()
        const hasNextData = html.includes('__NEXT_DATA__')
        const hasNextF = html.includes('self.__next_f')

        // Try to find price/name in HTML
        const priceMatch = html.match(/"price"\s*:\s*(\d+)/)
        const nameMatch = html.match(/"name"\s*:\s*"([^"]{5,80})"/)

        results[id] = {
          status: res.status,
          hasNextData,
          hasNextF,
          htmlLength: html.length,
          dataPreview: priceMatch ? `price=${priceMatch[1]}, name=${nameMatch?.[1]}` : null,
        }
      } catch (err) {
        results[id] = { status: 0, hasNextData: false, hasNextF: false, htmlLength: 0, dataPreview: String(err) }
      }
    })
  )

  return NextResponse.json(results)
}
