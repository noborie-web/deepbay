import { NextRequest, NextResponse } from 'next/server'
import { scrapeUrl } from '@/lib/scrapers'

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) {
    return NextResponse.json({ error: 'url parameter required' }, { status: 400 })
  }

  try {
    const product = await scrapeUrl(url)
    return NextResponse.json({ success: true, product })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
