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
    const hasNextF = html.includes('self.__next_f')

    // Extract RSC push data
    const pushMatches = [...html.matchAll(/self\.__next_f\.push\(\[(\d+),(.*?)\]\)/gs)]
    const rscCombined = pushMatches.map(m => m[2]).join('\n')

    // Search for product-like keys
    const keyPatterns = ['apparelUsedListings', 'listings', 'items', 'products', 'searchResults', 'result']
    const foundKeys: Record<string, string> = {}
    for (const key of keyPatterns) {
      const idx = rscCombined.indexOf(`"${key}"`)
      if (idx !== -1) {
        foundKeys[key] = rscCombined.slice(idx, idx + 300)
      }
    }

    // Also search full HTML
    const htmlKeys: Record<string, string> = {}
    for (const key of keyPatterns) {
      const idx = html.indexOf(`"${key}"`)
      if (idx !== -1) {
        htmlKeys[key] = html.slice(idx, idx + 300)
      }
    }

    return NextResponse.json({
      status: res.status,
      hasNextData,
      hasNextF,
      htmlLength: html.length,
      rscPushCount: pushMatches.length,
      rscCombinedLength: rscCombined.length,
      foundKeysInRsc: foundKeys,
      foundKeysInHtml: htmlKeys,
      rscSample: rscCombined.slice(0, 500),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
