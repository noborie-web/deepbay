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

// スポット文字・簡易除外・危険単語はいずれも「指定したキーワードが
// 商品の特定項目に含まれるか」という同一のロジックのため、1つの関数に
// まとめて共有する。判定対象項目(タイトル/ブランド/商品詳細)は
// fieldsで指定でき、デフォルトはタイトルのみ(既存の呼び出し元との互換維持)。
export function findKeywordProductIds(
  products: Product[],
  keywords: string[],
  fields: KeywordMatchField[] = ['title'],
): string[] {
  if (keywords.length === 0 || fields.length === 0) return []
  const lowerKeywords = keywords.map((w) => w.toLowerCase())
  return products
    .filter((product) => {
      const combined = fields.map((field) => keywordSearchText(product, field)).join(' ').toLowerCase()
      return lowerKeywords.some((w) => combined.includes(w))
    })
    .map((product) => product.id)
}

export function findDangerSellerProductIds(products: Product[], sellerUrls: string[]): string[] {
  if (sellerUrls.length === 0) return []
  const normalizedSellerUrls = sellerUrls.map((s) => s.split('?')[0].trim().replace(/\/+$/, ''))
  return products
    .filter((product) => {
      const norm = product.source_url.split('?')[0].trim().replace(/\/+$/, '')
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

export function findLowRatingProductIds(products: Product[], max: number | null): string[] {
  if (max === null) return []
  return products
    .filter((product) => product.seller_rating_count !== null && product.seller_rating_count <= max)
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
