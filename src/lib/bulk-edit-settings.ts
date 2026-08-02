import type { ScrapedProduct } from '@/lib/scrapers/types'

export type BulkTargetField = 'title' | 'description'

export interface BulkEditConfig {
  veroEnabled: boolean
  veroTargetFields: BulkTargetField[]
  dangerSellerEnabled: boolean
  dangerWordEnabled: boolean
  dangerWordTargetFields: BulkTargetField[]
  customWordEnabled: boolean
  customWordTargetFields: BulkTargetField[]
  customWords: string[]
  priceRangeEnabled: boolean
  minPrice: number | null
  maxPrice: number | null
  ratingCountEnabled: boolean
  minRatingCount: number | null
  lowRatingEnabled: boolean
  maxLowRatingCount: number | null
  updatedWithinEnabled: boolean
  updatedWithinMonths: number | null
  shippingDaysEnabled: boolean
  maxShippingDays: number | null
}

export const DEFAULT_BULK_EDIT_CONFIG: BulkEditConfig = {
  veroEnabled: false,
  veroTargetFields: ['title'],
  dangerSellerEnabled: true,
  dangerWordEnabled: true,
  dangerWordTargetFields: ['title', 'description'],
  customWordEnabled: false,
  customWordTargetFields: ['title', 'description'],
  customWords: [],
  priceRangeEnabled: false,
  minPrice: null,
  maxPrice: null,
  ratingCountEnabled: false,
  minRatingCount: null,
  lowRatingEnabled: false,
  maxLowRatingCount: null,
  updatedWithinEnabled: false,
  updatedWithinMonths: null,
  shippingDaysEnabled: false,
  maxShippingDays: null,
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function targetFields(value: unknown, fallback: BulkTargetField[]): BulkTargetField[] {
  if (!Array.isArray(value)) return fallback
  const fields = value.filter((field): field is BulkTargetField => (
    field === 'title' || field === 'description'
  ))
  return fields.length > 0 ? [...new Set(fields)] : fallback
}

export function normalizeBulkEditConfig(value: unknown): BulkEditConfig {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    ...DEFAULT_BULK_EDIT_CONFIG,
    veroEnabled: raw.veroEnabled === true,
    veroTargetFields: targetFields(raw.veroTargetFields, ['title']),
    dangerSellerEnabled: raw.dangerSellerEnabled !== false,
    dangerWordEnabled: raw.dangerWordEnabled !== false,
    dangerWordTargetFields: targetFields(raw.dangerWordTargetFields, ['title', 'description']),
    customWordEnabled: raw.customWordEnabled === true,
    customWordTargetFields: targetFields(raw.customWordTargetFields, ['title', 'description']),
    customWords: Array.isArray(raw.customWords)
      ? [...new Set(raw.customWords.map(String).map((word) => word.trim()).filter(Boolean))]
      : [],
    priceRangeEnabled: raw.priceRangeEnabled === true,
    minPrice: numberOrNull(raw.minPrice),
    maxPrice: numberOrNull(raw.maxPrice),
    ratingCountEnabled: raw.ratingCountEnabled === true,
    minRatingCount: numberOrNull(raw.minRatingCount),
    lowRatingEnabled: raw.lowRatingEnabled === true,
    maxLowRatingCount: numberOrNull(raw.maxLowRatingCount),
    updatedWithinEnabled: raw.updatedWithinEnabled === true,
    updatedWithinMonths: numberOrNull(raw.updatedWithinMonths),
    shippingDaysEnabled: raw.shippingDaysEnabled === true,
    maxShippingDays: numberOrNull(raw.maxShippingDays),
  }
}

export function productText(product: ScrapedProduct, fields: BulkTargetField[]): string {
  return fields.map((field) => (
    field === 'title' ? product.title : product.description
  )).join('\n')
}

export type BulkFilterReason =
  | 'vero'
  | 'danger_word'
  | 'custom_word'
  | 'price_range'
  | 'rating_count'
  | 'low_rating'
  | 'updated_months'
  | 'shipping_days'

export interface BulkFilterMatch {
  reasonCode: BulkFilterReason
  reasonLabel: string
  metadata: Record<string, unknown>
}

function includesWord(text: string, words: string[]): string | null {
  const normalized = text.normalize('NFKC').toLocaleLowerCase()
  return words.find((word) => normalized.includes(word.normalize('NFKC').toLocaleLowerCase())) ?? null
}

export function evaluateBulkProduct(
  product: ScrapedProduct & { sellerLowRatingCount?: number | null },
  config: BulkEditConfig,
  dependencies: { veroBrands: string[]; dangerWords: string[] },
  now = new Date(),
): BulkFilterMatch | null {
  if (config.veroEnabled) {
    const word = includesWord(productText(product, config.veroTargetFields), dependencies.veroBrands)
    if (word) return { reasonCode: 'vero', reasonLabel: 'Veroワード', metadata: { matchedWord: word } }
  }
  if (config.dangerWordEnabled) {
    const word = includesWord(productText(product, config.dangerWordTargetFields), dependencies.dangerWords)
    if (word) return { reasonCode: 'danger_word', reasonLabel: '危険単語', metadata: { matchedWord: word } }
  }
  if (config.customWordEnabled) {
    const word = includesWord(productText(product, config.customWordTargetFields), config.customWords)
    if (word) return { reasonCode: 'custom_word', reasonLabel: 'カスタムワード', metadata: { matchedWord: word } }
  }
  if (config.priceRangeEnabled && product.price !== null) {
    if ((config.minPrice !== null && product.price < config.minPrice)
      || (config.maxPrice !== null && product.price > config.maxPrice)) {
      return { reasonCode: 'price_range', reasonLabel: '価格範囲', metadata: { price: product.price } }
    }
  }
  if (config.ratingCountEnabled && config.minRatingCount !== null
    && product.sellerRatingCount !== null && product.sellerRatingCount < config.minRatingCount) {
    return {
      reasonCode: 'rating_count',
      reasonLabel: '評価数',
      metadata: { ratingCount: product.sellerRatingCount },
    }
  }
  if (config.lowRatingEnabled && config.maxLowRatingCount !== null
    && product.sellerLowRatingCount != null
    && product.sellerLowRatingCount > config.maxLowRatingCount) {
    return {
      reasonCode: 'low_rating',
      reasonLabel: '低評価数',
      metadata: { lowRatingCount: product.sellerLowRatingCount },
    }
  }
  if (config.updatedWithinEnabled && config.updatedWithinMonths !== null && product.sourceUpdatedAt) {
    const updated = new Date(product.sourceUpdatedAt)
    if (Number.isFinite(updated.getTime())) {
      const threshold = new Date(now)
      threshold.setMonth(threshold.getMonth() - config.updatedWithinMonths)
      if (updated < threshold) {
        return {
          reasonCode: 'updated_months',
          reasonLabel: '最終更新月',
          metadata: { sourceUpdatedAt: product.sourceUpdatedAt },
        }
      }
    }
  }
  if (config.shippingDaysEnabled && config.maxShippingDays !== null
    && product.shippingDays !== null && product.shippingDays > config.maxShippingDays) {
    return {
      reasonCode: 'shipping_days',
      reasonLabel: '発送日数',
      metadata: { shippingDays: product.shippingDays },
    }
  }
  return null
}

