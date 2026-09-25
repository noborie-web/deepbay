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

// ユーザー要望: UK(GBP)・AU(AUD)にも出品するため、通貨ごとの円レートが必要。
// frankfurter は /v2/rate/{通貨}/JPY で「1通貨 = N円」を返す。
export interface CurrencyJpyRate {
  currency: string
  rate: number
  date: string
}

export async function fetchJpyRate(currency: string): Promise<CurrencyJpyRate> {
  const code = currency.toUpperCase()
  if (code === 'JPY') return { currency: 'JPY', rate: 1, date: new Date().toISOString().slice(0, 10) }
  const response = await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(code)}/JPY`, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 3600 },
  })
  if (!response.ok) throw new Error(`${code}の為替レートを取得できませんでした`)
  const data = await response.json() as ExchangeRateResponse
  if (
    data.base !== code || data.quote !== 'JPY'
    || typeof data.date !== 'string' || typeof data.rate !== 'number'
    || !isFinite(data.rate) || data.rate <= 0
  ) {
    throw new Error(`${code}の為替レートの形式が不正です`)
  }
  return { currency: code, rate: data.rate, date: data.date }
}
