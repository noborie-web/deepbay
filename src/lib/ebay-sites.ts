// ユーザー要望: US に加えて UK・AU にも直接アップロードしたい。
// eBayのサイトごとに、CSVの SiteID / Currency と、Trading API の
// X-EBAY-API-SITEID(数値)が決まっている。価格はそのサイトの通貨で出す。
// marketplaceId は Sell API(ビジネスポリシー等)で使う識別子。
// ユーザー報告(2026-10-19): akebono-32 は UK/AU に出品する設定なのに、
// ポリシーをセラーの marketplaceId(EBAY_AU)でしか取っていなかったため、
// UK向けのポリシーが選択肢に出てこなかった。
// ビジネスポリシーはマーケットプレイスごとに別物なので、サイトごとに取る。
// 注意: UK の marketplaceId は EBAY_UK ではなく EBAY_GB。
export const EBAY_SITES = {
  US: { siteId: 'US', currency: 'USD', tradingSiteId: '0', marketplaceId: 'EBAY_US', label: 'アメリカ (US)' },
  UK: { siteId: 'UK', currency: 'GBP', tradingSiteId: '3', marketplaceId: 'EBAY_GB', label: 'イギリス (UK)' },
  AU: { siteId: 'AU', currency: 'AUD', tradingSiteId: '15', marketplaceId: 'EBAY_AU', label: 'オーストラリア (AU)' },
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

// ---------------------------------------------------------------------------
// 在庫管理でのサイト判定
//
// ユーザー要望(2026-09-25): UK/AUにも出品するが「混在しないよう細心の注意が
// 必要」。出品ごとにどのサイト・どの通貨かを確定できないと、GBPの価格をUSD
// として扱って大幅な値下げ・赤字になりかねない。Trading APIの Item.Site
// (US / UK / Australia など)と価格の currencyID から、出品のサイトを決める。
// 判断できない場合は null を返し、呼び出し側で価格改定の対象外にする。
// ---------------------------------------------------------------------------

const SITE_NAME_TO_KEY: Record<string, EbaySiteKey> = {
  US: 'US',
  'UNITED STATES': 'US',
  EBAY_US: 'US',
  UK: 'UK',
  'UNITED KINGDOM': 'UK',
  EBAY_GB: 'UK',
  GB: 'UK',
  AU: 'AU',
  AUSTRALIA: 'AU',
  EBAY_AU: 'AU',
}

const CURRENCY_TO_KEY: Record<string, EbaySiteKey> = {
  USD: 'US',
  GBP: 'UK',
  AUD: 'AU',
}

/** サイト(US/UK/AU) → Sell APIの marketplaceId(EBAY_US/EBAY_GB/EBAY_AU) */
export function marketplaceIdForSite(siteId: string | null | undefined): string {
  const key = siteKeyFromEbaySiteName(siteId)
  return key ? EBAY_SITES[key].marketplaceId : EBAY_SITES.US.marketplaceId
}

export function siteKeyFromEbaySiteName(value: string | null | undefined): EbaySiteKey | null {
  if (!value) return null
  return SITE_NAME_TO_KEY[value.trim().toUpperCase()] ?? null
}

export function siteKeyFromCurrency(value: string | null | undefined): EbaySiteKey | null {
  if (!value) return null
  return CURRENCY_TO_KEY[value.trim().toUpperCase()] ?? null
}

/**
 * 出品のサイト・通貨を確定する。
 * 通貨はeBayが返した currencyID を最優先する(価格の単位そのものなので、
 * ここを取り違えると価格改定が破綻する)。サイト名しか無い場合はそのサイトの
 * 既定通貨を使い、どちらも分からなければ null(＝判定不能)を返す。
 */
export function resolveListingSite(
  siteName: string | null | undefined,
  currency: string | null | undefined,
): { siteId: EbaySiteKey; currency: string } | null {
  const byCurrency = siteKeyFromCurrency(currency)
  if (byCurrency) return { siteId: byCurrency, currency: EBAY_SITES[byCurrency].currency }
  const bySite = siteKeyFromEbaySiteName(siteName)
  if (bySite) return { siteId: bySite, currency: EBAY_SITES[bySite].currency }
  // Kakehashiが対応していないサイト(ドイツ等)の出品。通貨が分かる場合は
  // そのまま記録し、価格改定の対象外として扱えるようにする。
  if (currency && currency.trim()) return null
  return null
}

export function currencyForSite(siteId: string | null | undefined): string {
  const key = EBAY_SITE_KEYS.find(k => EBAY_SITES[k].siteId === (siteId ?? 'US').toUpperCase())
  return key ? EBAY_SITES[key].currency : 'USD'
}
