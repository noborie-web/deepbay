// ユーザー要望: US に加えて UK・AU にも直接アップロードしたい。
// eBayのサイトごとに、CSVの SiteID / Currency と、Trading API の
// X-EBAY-API-SITEID(数値)が決まっている。価格はそのサイトの通貨で出す。
export const EBAY_SITES = {
  US: { siteId: 'US', currency: 'USD', tradingSiteId: '0', label: 'アメリカ (US)' },
  UK: { siteId: 'UK', currency: 'GBP', tradingSiteId: '3', label: 'イギリス (UK)' },
  AU: { siteId: 'AU', currency: 'AUD', tradingSiteId: '15', label: 'オーストラリア (AU)' },
} as const

export type EbaySiteKey = keyof typeof EBAY_SITES
export type EbaySite = (typeof EBAY_SITES)[EbaySiteKey]

export const EBAY_SITE_KEYS = Object.keys(EBAY_SITES) as EbaySiteKey[]

export function isEbaySiteKey(value: unknown): value is EbaySiteKey {
  return typeof value === 'string' && value in EBAY_SITES
}

export function normalizeSiteKeys(value: string | null | undefined): EbaySiteKey[] {
  const keys = (value ?? 'US')
    .split(',')
    .map(v => v.trim().toUpperCase())
    .filter(isEbaySiteKey)
  return keys.length > 0 ? Array.from(new Set(keys)) : ['US']
}

// Trading API の SiteID(数値)。未知のサイトはUS(0)にフォールバックする。
export function tradingSiteIdFor(siteId: string | null | undefined): string {
  const key = EBAY_SITE_KEYS.find(k => EBAY_SITES[k].siteId === (siteId ?? 'US').toUpperCase())
  return key ? EBAY_SITES[key].tradingSiteId : '0'
}

/**
 * 出品時の価格(USD)を、同じ円価値になるように別サイトの通貨へ換算する。
 * 価格一括編集で手動調整した価格も、その調整を保ったまま換算できる。
 *  priceJpy = usdPrice × 出品時レート(円/USD)
 *  結果     = priceJpy ÷ 対象通貨のレート(円/通貨)
 */
export function convertListingPrice(
  usdPrice: number,
  jpyPerUsd: number,
  jpyPerTargetCurrency: number,
): number | null {
  if (!(usdPrice > 0) || !(jpyPerUsd > 0) || !(jpyPerTargetCurrency > 0)) return null
  const priceJpy = usdPrice * jpyPerUsd
  return Math.ceil((priceJpy / jpyPerTargetCurrency) * 100) / 100
}
