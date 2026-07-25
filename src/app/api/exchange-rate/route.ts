import { parseUsdJpyRate } from '@/lib/exchange-rate'
import type { ExchangeRateResponse } from '@/lib/exchange-rate'

export async function GET() {
  try {
    const response = await fetch('https://api.frankfurter.dev/v2/rate/USD/JPY', {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    })
    if (!response.ok) {
      return Response.json(
        { error: '為替レートを取得できませんでした' },
        { status: 502 },
      )
    }

    const parsed = parseUsdJpyRate(await response.json() as ExchangeRateResponse)
    if (!parsed) {
      return Response.json(
        { error: '為替レートの形式が不正です' },
        { status: 502 },
      )
    }

    return Response.json({
      ...parsed,
      base: 'USD',
      quote: 'JPY',
      source: 'Frankfurter / central bank reference rates',
    })
  } catch {
    return Response.json(
      { error: '為替レートを取得できませんでした' },
      { status: 502 },
    )
  }
}
