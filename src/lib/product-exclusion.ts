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

function normalizeUrl(value: string): string {
  return value.split('?')[0].trim().replace(/\/+$/, '')
}

function normalizeKeywords(keywords: string[]): string[] {
  return keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)
}

export function findDangerSellerProductIds(
  products: Product[],
  sellerUrls: string[],
): string[] {
  const normalizedSellers = sellerUrls.map(normalizeUrl).filter(Boolean)
  return products
    .filter((product) => {
      const sourceUrl = normalizeUrl(product.source_url)
      return normalizedSellers.some((sellerUrl) => sourceUrl.startsWith(sellerUrl))
    })
    .map((product) => product.id)
}

export function findTitleKeywordProductIds(
  products: Product[],
  keywords: string[],
): string[] {
  const normalizedKeywords = normalizeKeywords(keywords)
  if (normalizedKeywords.length === 0) return []

  return products
    .filter((product) => {
      const title = product.original_title.toLowerCase()
      return normalizedKeywords.some((keyword) => title.includes(keyword))
    })
    .map((product) => product.id)
}

export function findPriceRangeProductIds(
  products: Product[],
  target: 'original' | 'ebay',
  min: number | null,
  max: number | null,
): string[] {
  if (min === null && max === null) return []

  return products
    .filter((product) => {
      const price = target === 'original'
        ? (product.original_price ?? 0)
        : (product.ebay_price ?? 0)
      if (min !== null && price < min) return true
      return max !== null && price > max
    })
    .map((product) => product.id)
}

export function findSellerRatingProductIds(
  products: Product[],
  max: number | null,
): string[] {
  if (max === null || !Number.isFinite(max) || max < 0) return []
  return products
    .filter((product) => (
      product.seller_rating_count !== null
      && product.seller_rating_count <= max
    ))
    .map((product) => product.id)
}

export function findShippingDaysProductIds(
  products: Product[],
  max: number | null,
): string[] {
  if (max === null || !Number.isFinite(max) || max < 1) return []
  return products
    .filter((product) => product.shipping_days !== null && product.shipping_days > max)
    .map((product) => product.id)
}

export function findUpdatedAtProductIds(
  products: Product[],
  months: number,
  now = new Date(),
): string[] {
  if (!Number.isFinite(months) || months <= 0) return []
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - months)

  return products
    .filter((product) => (
      Boolean(product.source_updated_at)
      && new Date(product.source_updated_at as string) < cutoff
    ))
    .map((product) => product.id)
}
