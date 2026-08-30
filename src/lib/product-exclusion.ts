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

// スポット文字・簡易除外・危険単語はいずれも「商品タイトルにキーワードが
// 含まれるか」という同一のロジックのため、1つの関数にまとめて共有する。
export function findKeywordProductIds(products: Product[], keywords: string[]): string[] {
  if (keywords.length === 0) return []
  const lowerKeywords = keywords.map((w) => w.toLowerCase())
  return products
    .filter((product) => {
      const lower = product.original_title.toLowerCase()
      return lowerKeywords.some((w) => lower.includes(w))
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
