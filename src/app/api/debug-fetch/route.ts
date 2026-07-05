import { NextRequest, NextResponse } from 'next/server'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'url parameter required' }, { status: 400 })
  }

  try {
    const res = await fetch(url, { headers: HEADERS })
    const html = await res.text()
    const hasNextData = html.includes('__NEXT_DATA__')
    const preview = html.slice(0, 2000)

    const hasNextF = html.includes('self.__next_f')
    const hasAppJson = html.includes('application/json')

    // Extract self.__next_f push calls (RSC flight data)
    const nextFMatches = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)/gs)]
      .slice(0, 5)
      .map(m => m[1].slice(0, 500))

    // Find any JSON-like structures with listing/item data
    const listingMatch = html.match(/"apparelUsedListings":\s*(\[.{0,2000})/s)
    const itemsMatch = html.match(/"items":\s*(\[.{0,2000})/s)
    const searchMatch = html.match(/"searchResults":\s*(\[.{0,2000})/s)

    return NextResponse.json({
      status: res.status,
      hasNextData,
      hasNextF,
      hasAppJson,
      htmlLength: html.length,
      nextFSamples: nextFMatches,
      listingPreview: listingMatch?.[1]?.slice(0, 500) ?? null,
      itemsPreview: itemsMatch?.[1]?.slice(0, 500) ?? null,
      searchPreview: searchMatch?.[1]?.slice(0, 500) ?? null,
      preview,
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
