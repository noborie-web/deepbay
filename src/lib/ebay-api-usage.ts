// ---------------------------------------------------------------------------
// eBay APIの上限と使用量(GetAPIAccessRules)
//
// ユーザー要望(2026-09-30): APIの容量と消費が見えるようにしたい。
// 2026-09-26〜27に呼び出し上限へ達して同期・取り下げ・価格改定が止まったが、
// 当時は「あとどれだけ使えるのか」を確認する手段が無かった。
// eBayは GetAPIAccessRules で呼び出しごとの上限と当日の使用量を返す。
// ---------------------------------------------------------------------------
const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'

export interface EbayApiUsageRule {
  // 呼び出し名(空ならアプリ全体の集計枠)
  callName: string
  dailyUsage: number
  dailyLimit: number
  hourlyUsage: number
  hourlyLimit: number
  // 在庫管理で実際に使う呼び出しかどうか(画面で強調するため)
  used: boolean
}

// Kakehashiの在庫管理が使う呼び出し
const USED_CALL_NAMES = new Set([
  'GetMyeBaySelling',
  'GetSellerList',
  'GetItem',
  'ReviseInventoryStatus',
  'EndItem',
  'ReviseItem',
  'AddFixedPriceItem',
])

function tag(src: string, name: string): string {
  const m = src.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return m ? m[1].trim() : ''
}

function num(value: string): number {
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : 0
}

export function parseApiAccessRules(xml: string): EbayApiUsageRule[] {
  const ack = tag(xml, 'Ack')
  if (ack === 'Failure') {
    const message = tag(xml, 'LongMessage') || tag(xml, 'ShortMessage')
    throw new Error(message || 'eBayの利用状況を取得できませんでした')
  }
  const blocks = xml.match(/<ApiAccessRule>[\s\S]*?<\/ApiAccessRule>/gi) ?? []
  return blocks.map(block => {
    const callName = tag(block, 'CallName')
    return {
      callName: callName || '(アプリ全体)',
      dailyUsage: num(tag(block, 'DailyUsage')),
      dailyLimit: num(tag(block, 'DailyHardLimit')),
      hourlyUsage: num(tag(block, 'HourlyUsage')),
      hourlyLimit: num(tag(block, 'HourlyHardLimit')),
      used: callName === '' || USED_CALL_NAMES.has(callName),
    }
  })
}

export async function fetchApiAccessRules(accessToken: string, timeoutMs = 15_000): Promise<EbayApiUsageRule[]> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents" />`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(TRADING_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetApiAccessRules',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-IAF-TOKEN': accessToken,
      },
      body: xml,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`eBay API HTTP error: ${res.status}`)
    return parseApiAccessRules(await res.text())
  } finally {
    clearTimeout(timeout)
  }
}
