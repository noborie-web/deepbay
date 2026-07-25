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
