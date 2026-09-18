// eBay Trading API GetItem — 出品の詳細(タイトル・説明・画像・状態・カテゴリ)を
// 取得する。ユーザー要望(事故復旧): 抽出の削除で消えた出品済み商品を、
// eBay上の出品からKakehashiに復元するために使う。
const EBAY_TRADING_API_URL = 'https://api.ebay.com/ws/api.dll'

export interface EbayItemDetails {
  itemId: string
  sku: string | null
  title: string
  descriptionHtml: string
  pictureUrls: string[]
  currentPrice: number | null
  quantity: number | null
  quantitySold: number
  listingStatus: string
  conditionId: string | null
  categoryId: string | null
  startTime: string | null
}

function getTag(src: string, tag: string): string {
  const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1].trim() : ''
}

function decodeXml(value: string): string {
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/)
  const raw = cdata ? cdata[1] : value
  return raw
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export function parseGetItemDetails(xml: string, itemId: string): EbayItemDetails | 'not_found' {
  if (getTag(xml, 'Ack') === 'Failure') {
    const code = getTag(xml, 'ErrorCode')
    if (['17', '37', '21916750', '21917182'].includes(code)) return 'not_found'
    throw new Error(`eBay GetItem error (${itemId}): ${getTag(xml, 'LongMessage') || getTag(xml, 'ShortMessage') || `code ${code}`}`)
  }
  const item = xml.match(/<Item>[\s\S]*?<\/Item>/i)?.[0] ?? ''
  if (!item) return 'not_found'
  const sellingStatus = item.match(/<SellingStatus>[\s\S]*?<\/SellingStatus>/i)?.[0] ?? ''
  const pictureDetails = item.match(/<PictureDetails>[\s\S]*?<\/PictureDetails>/i)?.[0] ?? ''
  const listingDetails = item.match(/<ListingDetails>[\s\S]*?<\/ListingDetails>/i)?.[0] ?? ''
  const primaryCategory = item.match(/<PrimaryCategory>[\s\S]*?<\/PrimaryCategory>/i)?.[0] ?? ''
  const num = (s: string) => { const n = parseFloat(s); return isFinite(n) ? n : null }
  const total = num(getTag(item, 'Quantity'))
  const sold = num(getTag(sellingStatus, 'QuantitySold')) ?? 0
  const pictureUrls = Array.from(pictureDetails.matchAll(/<PictureURL>([\s\S]*?)<\/PictureURL>/gi)).map(m => decodeXml(m[1].trim())).filter(Boolean)
  return {
    itemId: getTag(item, 'ItemID') || itemId,
    sku: getTag(item, 'SKU') || null,
    title: decodeXml(getTag(item, 'Title')),
    descriptionHtml: decodeXml(getTag(item, 'Description')),
    pictureUrls,
    currentPrice: num(getTag(sellingStatus, 'CurrentPrice')),
    quantity: total != null ? Math.max(0, Math.round(total - sold)) : null,
    quantitySold: Math.round(sold),
    listingStatus: getTag(sellingStatus, 'ListingStatus') || 'Active',
    conditionId: getTag(item, 'ConditionID') || null,
    categoryId: getTag(primaryCategory, 'CategoryID') || null,
    startTime: getTag(listingDetails, 'StartTime') || null,
  }
}

export async function fetchEbayItemDetails(accessToken: string, itemId: string, timeoutMs = 20_000): Promise<EbayItemDetails | 'not_found'> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>false</IncludeItemSpecifics>
</GetItemRequest>`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(EBAY_TRADING_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-IAF-TOKEN': accessToken,
        'X-EBAY-API-SITEID': '0',
      },
      body: xml,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`eBay API HTTP error: ${res.status}`)
    return parseGetItemDetails(await res.text(), itemId)
  } finally {
    clearTimeout(timer)
  }
}

// Kakehashiが出力した説明文HTML(<h2>Description</h2><p>Condition…</p><p>本文</p>
// <h2>Shipping</h2>…)から本文だけを取り出す。それ以外のHTMLはタグを除いた
// テキストにする。
export function extractDescriptionBody(html: string): string {
  const section = html.match(/<h2>Description<\/h2>(?:<p>Condition:[\s\S]*?<\/p>)?<p>([\s\S]*?)<\/p>\s*<h2>Shipping<\/h2>/i)
  const source = section ? section[1] : html
  return source
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// eBay ConditionID → Kakehashiの商品状態(ALLOWED_CONDITIONS のいずれか)。
// 本番の出品はメディア用マッピング(新品→2750, 中古→5000 等)なので、
// 2750/4000/5000/6000 はそれぞれ 新品同様/良い/中古/ジャンク に戻す。
export function conditionFromEbayId(conditionId: string | null): string | null {
  switch (conditionId) {
    case '1000': return '新品'
    case '1500': return '新品同様'
    case '2750': return '新品同様'
    case '2500': return '良い'
    case '4000': return '良い'
    case '3000': return '中古'
    case '5000': return '中古'
    case '6000': return 'ジャンク'
    case '7000': return 'ジャンク'
    default: return conditionId ? '中古' : null
  }
}
