import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUsdJpyRate } from '@/lib/exchange-rate'
import { GET } from '@/app/api/exchange-rate/route'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseUsdJpyRate', () => {
  it('USD/JPYの正常なレスポンスを解析する', () => {
    expect(parseUsdJpyRate({
      date: '2026-07-25',
      base: 'USD',
      quote: 'JPY',
      rate: 163.64,
    })).toEqual({ rate: 163.64, date: '2026-07-25' })
  })

  it('通貨ペア・日付・レートが不正なら拒否する', () => {
    expect(parseUsdJpyRate({
      date: '2026-07-25',
      base: 'EUR',
      quote: 'JPY',
      rate: 163.64,
    })).toBeNull()
    expect(parseUsdJpyRate({
      date: '2026-07-25',
      base: 'USD',
      quote: 'JPY',
      rate: -1,
    })).toBeNull()
  })
})

describe('GET /api/exchange-rate', () => {
  it('取得した最新レートと基準日を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        date: '2026-07-25',
        base: 'USD',
        quote: 'JPY',
        rate: 163.64,
      }),
    })))

    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      rate: 163.64,
      date: '2026-07-25',
      base: 'USD',
      quote: 'JPY',
    })
  })

  it('外部APIエラー時は502を返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })))

    const response = await GET()
    expect(response.status).toBe(502)
  })
})
