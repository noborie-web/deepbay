import { describe, expect, it, vi } from 'vitest'
import { fetchApiAccessRules, parseApiAccessRules } from '@/lib/ebay-api-usage'

// ユーザー要望(2026-09-30): APIの容量と消費が見えるようにしたい。
// 2026-09-26〜27に上限へ達して同期・取り下げ・価格改定が止まったが、
// 当時は残量を確認する手段が無かった。
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<GetApiAccessRulesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ApiAccessRule>
    <CallName>GetItem</CallName>
    <DailyHardLimit>5000</DailyHardLimit>
    <DailyUsage>4900</DailyUsage>
    <HourlyHardLimit>1000</HourlyHardLimit>
    <HourlyUsage>120</HourlyUsage>
  </ApiAccessRule>
  <ApiAccessRule>
    <CallName>GetMyeBaySelling</CallName>
    <DailyHardLimit>5000</DailyHardLimit>
    <DailyUsage>51</DailyUsage>
    <HourlyHardLimit>1000</HourlyHardLimit>
    <HourlyUsage>51</HourlyUsage>
  </ApiAccessRule>
  <ApiAccessRule>
    <CallName>SomeUnusedCall</CallName>
    <DailyHardLimit>5000</DailyHardLimit>
    <DailyUsage>0</DailyUsage>
    <HourlyHardLimit>1000</HourlyHardLimit>
    <HourlyUsage>0</HourlyUsage>
  </ApiAccessRule>
</GetApiAccessRulesResponse>`

describe('eBay APIの利用状況', () => {
  it('呼び出しごとの当日使用量と上限を読み取る', () => {
    const rules = parseApiAccessRules(SAMPLE)
    expect(rules).toHaveLength(3)
    const getItem = rules.find(r => r.callName === 'GetItem')!
    expect(getItem).toMatchObject({ dailyUsage: 4900, dailyLimit: 5000, hourlyUsage: 120, used: true })
  })

  it('在庫管理で使う呼び出しだけ used=true にする', () => {
    const rules = parseApiAccessRules(SAMPLE)
    expect(rules.find(r => r.callName === 'GetMyeBaySelling')?.used).toBe(true)
    expect(rules.find(r => r.callName === 'SomeUnusedCall')?.used).toBe(false)
  })

  it('eBayがエラーを返したら理由を伝える', () => {
    expect(() => parseApiAccessRules('<Ack>Failure</Ack><LongMessage>Invalid token</LongMessage>'))
      .toThrow('Invalid token')
  })

  it('GetApiAccessRules として問い合わせる', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      expect(init.headers['X-EBAY-API-CALL-NAME']).toBe('GetApiAccessRules')
      return { ok: true, text: async () => SAMPLE } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const rules = await fetchApiAccessRules('token')
    expect(rules).toHaveLength(3)
    vi.unstubAllGlobals()
  })
})
