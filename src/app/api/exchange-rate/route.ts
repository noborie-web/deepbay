import { fetchUsdJpyRate } from '@/lib/exchange-rate'

export async function GET() {
  try {
    const parsed = await fetchUsdJpyRate()

    return Response.json({
      ...parsed,
      base: 'USD',
      quote: 'JPY',
      source: 'Frankfurter / central bank reference rates',
    })
  } catch (error) {
    const message = error instanceof Error && error.message === '為替レートの形式が不正です'
      ? error.message
      : '為替レートを取得できませんでした'
    return Response.json(
      { error: message },
      { status: 502 },
    )
  }
}
