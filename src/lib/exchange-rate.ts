export interface ExchangeRateResponse {
  date?: unknown
  base?: unknown
  quote?: unknown
  rate?: unknown
}

export interface UsdJpyRate {
  rate: number
  date: string
}

export function parseUsdJpyRate(data: ExchangeRateResponse): UsdJpyRate | null {
  if (
    data.base !== 'USD'
    || data.quote !== 'JPY'
    || typeof data.date !== 'string'
    || typeof data.rate !== 'number'
    || !isFinite(data.rate)
    || data.rate <= 0
  ) {
    return null
  }
  return { rate: data.rate, date: data.date }
}

export async function fetchUsdJpyRate(): Promise<UsdJpyRate> {
  const response = await fetch('https://api.frankfurter.dev/v2/rate/USD/JPY', {
    headers: { Accept: 'application/json' },
    next: { revalidate: 3600 },
  })
  if (!response.ok) throw new Error('為替レートを取得できませんでした')

  const parsed = parseUsdJpyRate(await response.json() as ExchangeRateResponse)
  if (!parsed) throw new Error('為替レートの形式が不正です')
  return parsed
}
