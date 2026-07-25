import type { Product } from '@/types/database'

export type SearchPriceTarget = 'original' | 'ebay'
export type SearchPriceState = 'all' | 'set' | 'unset'

export interface ProductSearchFilters {
  query: string
  sourceSite: string
  condition: string
  priceType: string
  priceState: SearchPriceState
  priceTarget: SearchPriceTarget
  priceMin: string
  priceMax: string
}

export const DEFAULT_PRODUCT_SEARCH_FILTERS: ProductSearchFilters = {
  query: '',
  sourceSite: 'all',
  condition: 'all',
  priceType: 'all',
  priceState: 'all',
  priceTarget: 'original',
  priceMin: '',
  priceMax: '',
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''
}

function parseOptionalNumber(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function searchableText(product: Product): string {
  const specifics = Object.entries(product.ebay_item_specifics ?? {})
    .flatMap(([name, values]) => [name, ...values])

  return [
    product.source_item_id,
    product.source_url,
    product.source_site,
    product.original_title,
    product.ebay_title,
    product.original_description,
    product.ebay_description,
    product.ebay_brand,
    product.original_condition,
    product.ebay_condition,
    ...specifics,
  ].map(normalize).join(' ')
}

export function filterProducts(
  products: Product[],
  filters: ProductSearchFilters,
): Product[] {
  const tokens = normalize(filters.query).split(/\s+/).filter(Boolean)
  const priceMin = parseOptionalNumber(filters.priceMin)
  const priceMax = parseOptionalNumber(filters.priceMax)

  return products.filter((product) => {
    const haystack = searchableText(product)
    if (!tokens.every((token) => haystack.includes(token))) return false
    if (filters.sourceSite !== 'all' && product.source_site !== filters.sourceSite) return false

    const condition = product.ebay_condition ?? product.original_condition ?? ''
    if (filters.condition !== 'all' && condition !== filters.condition) return false
    if (filters.priceType !== 'all' && product.price_type !== filters.priceType) return false
    if (filters.priceState === 'set' && product.ebay_price == null) return false
    if (filters.priceState === 'unset' && product.ebay_price != null) return false

    const price = filters.priceTarget === 'original'
      ? (product.purchase_price_jpy ?? product.original_price)
      : product.ebay_price
    if ((priceMin !== null || priceMax !== null) && price == null) return false
    if (priceMin !== null && price! < priceMin) return false
    if (priceMax !== null && price! > priceMax) return false
    return true
  })
}
