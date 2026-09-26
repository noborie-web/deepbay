import type { Product } from '@/types/database'

export type ProductPriceType = 'fixed' | 'auction'

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function textContainsBrand(text: string | null, brand: string): boolean {
  if (!text) return false
  const normalizedText = normalize(text)
  const normalizedBrand = normalize(brand)
  if (!normalizedBrand) return false

  // 英数字ブランドは語の境界を確認し、"ace" が "space" に一致するような誤検出を防ぐ。
  if (/^[a-z0-9][a-z0-9 .&'_-]*$/.test(normalizedBrand)) {
    return new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(normalizedBrand)}([^a-z0-9]|$)`,
      'i',
    ).test(normalizedText)
  }

  return normalizedText.includes(normalizedBrand)
}

export function matchesVeroBrand(product: Product, brands: string[]): boolean {
  return brands.some((brand) => {
    const normalizedBrand = normalize(brand)
    if (!normalizedBrand) return false

    if (product.ebay_brand && normalize(product.ebay_brand) === normalizedBrand) {
      return true
    }

    return (
      textContainsBrand(product.original_title, brand)
      || textContainsBrand(product.ebay_title, brand)
    )
  })
}

// 抽出パイプライン(タイトル翻訳・ebay_brand付与より前)でも使えるよう、
// タイトル文字列だけでVeroブランド一致を判定する版。matchesVeroBrandと
// ロジックを共有する(タイトルに含まれるかの判定は同一)。
export function matchesVeroBrandInTitle(title: string, brands: string[]): boolean {
  return brands.some((brand) => textContainsBrand(title, brand))
}

export function findVeroProductIds(products: Product[], brands: string[]): string[] {
  return products.filter((product) => matchesVeroBrand(product, brands)).map((product) => product.id)
}

export function getProductPriceType(product: Product): ProductPriceType {
  return product.price_type === 'auction' ? 'auction' : 'fixed'
}

export function findPriceTypeProductIds(
  products: Product[],
  selectedTypes: ProductPriceType[],
): string[] {
  const selected = new Set(selectedTypes)
  return products
    .filter((product) => selected.has(getProductPriceType(product)))
    .map((product) => product.id)
}

export type KeywordMatchField = 'title' | 'brand' | 'description'

function keywordSearchText(product: Product, field: KeywordMatchField): string {
  switch (field) {
    case 'title': return product.original_title
    case 'brand': return product.ebay_brand ?? ''
    case 'description': return product.ebay_description ?? ''
  }
}

// ---------------------------------------------------------------------------
// キーワード判定(危険単語・スポット文字・簡易除外で共通)
//
// 本番で確認した不具合(2026-09-26): 146件中103件が危険単語で除外対象になった。
// 原因は「部分一致」と「短すぎる単語」で、登録済みの危険単語に "g" や "_" が
// 含まれていたため英語タイトルのほぼ全件に当たっていた(g=148件 / _=148件 /
// not=107件)。また gun が Gundam に、not が another に当たる状態だった。
//
// - 英数字のキーワードは前後が英字でないときだけ一致とみなす(Gundam は gun に
//   当たらない。iPhone12 は iPhone に当たる)
// - 日本語など英字以外を含むキーワードは、単語の区切りが無いので従来どおり
//   部分一致で判定する
// - 1文字の英数字や記号だけのキーワードは、意味のある一致にならないため無視する
// ---------------------------------------------------------------------------

const ASCII_KEYWORD_RE = /^[\x20-\x7e]+$/

// 判定に使えないキーワード(1文字の英数字・記号だけ)かどうか
export function isIgnorableKeyword(keyword: string): boolean {
  const trimmed = keyword.trim()
  if (!trimmed) return true
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true
  return ASCII_KEYWORD_RE.test(trimmed) && trimmed.length < 2
}

function keywordMatcher(keyword: string): (text: string) => boolean {
  const trimmed = keyword.trim()
  const lower = trimmed.toLowerCase()
  if (!ASCII_KEYWORD_RE.test(trimmed)) {
    // 日本語などは区切りが無いため部分一致
    return (text) => text.includes(lower)
  }
  const re = new RegExp(`(?<![a-z])${escapeRegExp(lower)}(?![a-z])`, 'i')
  return (text) => re.test(text)
}

export function findKeywordProductIds(
  products: Product[],
  keywords: string[],
  fields: KeywordMatchField[] = ['title'],
): string[] {
  const matchers = buildKeywordMatchers(keywords)
  if (matchers.length === 0 || fields.length === 0) return []
  return products
    .filter((product) => {
      const combined = keywordText(product, fields)
      return matchers.some(({ match }) => match(combined))
    })
    .map((product) => product.id)
}

function keywordText(product: Product, fields: KeywordMatchField[]): string {
  return fields.map((field) => keywordSearchText(product, field)).join(' ').toLowerCase()
}

function buildKeywordMatchers(keywords: string[]): Array<{ keyword: string; match: (text: string) => boolean }> {
  const seen = new Set<string>()
  const matchers: Array<{ keyword: string; match: (text: string) => boolean }> = []
  for (const keyword of keywords) {
    const trimmed = keyword.trim()
    if (isIgnorableKeyword(trimmed)) continue
    const key = trimmed.toLowerCase()
    // 同じ単語が重複登録されていても1回だけ評価する
    if (seen.has(key)) continue
    seen.add(key)
    matchers.push({ keyword: trimmed, match: keywordMatcher(trimmed) })
  }
  return matchers
}

export interface KeywordMatchBreakdown {
  // 単語ごとの該当件数(多い順)
  hits: Array<{ keyword: string; count: number }>
  // 判定に使えないため無視した単語(1文字の英数字・記号だけ)
  ignored: string[]
}

/**
 * どの単語が何件に当たっているかを返す。誤爆している単語を見つけて
 * 危険単語リストを直せるようにするため、除外パネルで表示する。
 */
export function keywordMatchBreakdown(
  products: Product[],
  keywords: string[],
  fields: KeywordMatchField[] = ['title'],
): KeywordMatchBreakdown {
  const ignored = Array.from(new Set(
    keywords.map(k => k.trim()).filter(k => k.length > 0 && isIgnorableKeyword(k)),
  ))
  const matchers = buildKeywordMatchers(keywords)
  if (matchers.length === 0 || fields.length === 0) return { hits: [], ignored }

  const texts = products.map((product) => keywordText(product, fields))
  const hits = matchers
    .map(({ keyword, match }) => ({ keyword, count: texts.filter(text => match(text)).length }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
  return { hits, ignored }
}

// バグ修正: 以前はproduct.source_url(商品ページURL)を登録済み危険セラー
// URL(出品者プロフィールURL)と比較していたが、この2つは形の異なるURL
// のため一致判定が構造的に成立しなかった。抽出時にsellerUrlが保存される
// ようになった(products.seller_url)ため、そちらと比較する。抽出時点で
// seller_urlを取得できなかった/保存前の古い商品は判定できないため
// 対象外とする(安全側)。
export function findDangerSellerProductIds(products: Product[], sellerUrls: string[]): string[] {
  if (sellerUrls.length === 0) return []
  const normalizedSellerUrls = sellerUrls.map((s) => s.split('?')[0].trim().replace(/\/+$/, ''))
  return products
    .filter((product) => {
      if (!product.seller_url) return false
      const norm = product.seller_url.split('?')[0].trim().replace(/\/+$/, '')
      return normalizedSellerUrls.some((s) => norm.startsWith(s))
    })
    .map((product) => product.id)
}

export function findPriceRangeProductIds(
  products: Product[],
  min: number | null,
  max: number | null,
  target: 'original' | 'ebay',
): string[] {
  if (min === null && max === null) return []
  return products
    .filter((product) => {
      const price = target === 'original' ? (product.original_price ?? 0) : (product.ebay_price ?? 0)
      if (min !== null && price < min) return true
      if (max !== null && price > max) return true
      return false
    })
    .map((product) => product.id)
}

// 既存ツール(公式)との機能監査で発見: 評価数除外は「N件以下」ではなく
// 「N件未満」(下限)で判定する。境界値ちょうど(N件)のセラーは対象外。
export function findLowRatingProductIds(products: Product[], min: number | null): string[] {
  if (min === null) return []
  return products
    .filter((product) => product.seller_rating_count !== null && product.seller_rating_count < min)
    .map((product) => product.id)
}

export function findSlowShippingProductIds(products: Product[], max: number | null): string[] {
  if (max === null) return []
  return products
    .filter((product) => product.shipping_days !== null && product.shipping_days > max)
    .map((product) => product.id)
}

export function findStaleProductIds(products: Product[], monthsAgo: number): string[] {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - monthsAgo)
  return products
    .filter((product) => {
      if (!product.source_updated_at) return false
      return new Date(product.source_updated_at) < cutoff
    })
    .map((product) => product.id)
}
