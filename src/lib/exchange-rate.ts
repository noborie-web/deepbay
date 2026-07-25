export interface ExchangeRateResponse {
  date?: unknown
  base?: unknown
  quote?: unknown
  rate?: unknown
}

export function parseUsdJpyRate(data: ExchangeRateResponse): {
  rate: number
  date: string
} | null {
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
