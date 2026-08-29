import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'

interface TrefacOffer {
  price?: string | number
  itemCondition?: string
}

interface TrefacProductJsonLd {
  name?: string
  description?: string
  image?: string[] | string
  brand?: { name?: string }
  offers?: TrefacOffer
}

const CONDITION_LABELS: Record<string, string> = {
  'http://schema.org/UsedCondition': '中古',
  'https://schema.org/UsedCondition': '中古',
  'http://schema.org/NewCondition': '新品',
  'https://schema.org/NewCondition': '新品',
}

export class TrefacScraper extends BaseScraper {
  name = 'トレファクファッション'
  siteKey = 'trefac'
  urlPattern = /trefac\.jp\/store\/[^/]+\/[^/]+\/?/

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/\/store\/[^/]+\/([^/]+)\/?/)?.[1] ?? null

    const jsonLdBlocks = $('script[type="application/ld+json"]').toArray()
    const data: TrefacProductJsonLd | undefined = jsonLdBlocks
      .map((el): TrefacProductJsonLd | null => {
        try {
          const parsed = JSON.parse($(el).text())
          const candidate = Array.isArray(parsed) ? parsed[0] : parsed
          return candidate?.['@type'] === 'Product' ? (candidate as TrefacProductJsonLd) : null
        } catch {
          return null
        }
      })
      .find((candidate): candidate is TrefacProductJsonLd => candidate !== null)

    const title = data?.name?.trim()
      || $('meta[property="og:title"]').attr('content')?.trim()
      || ''

    const priceRaw = data?.offers?.price
    const price = priceRaw != null ? parseInt(String(priceRaw), 10) || null : null

    const description = data?.description?.trim() || ''

    const imageValue = data?.image
    const images = Array.isArray(imageValue) ? imageValue : (imageValue ? [imageValue] : [])

    const conditionUrl = data?.offers?.itemCondition
    const condition = conditionUrl ? (CONDITION_LABELS[conditionUrl] ?? null) : null

    return {
      sourceUrl: url,
      sourceSite: this.siteKey,
      sourceItemId: itemId,
      title,
      price,
      description,
      images,
      condition,
      category: data?.brand?.name ?? null,
      sellerRatingCount: null,
      shippingDays: null,
      sourceUpdatedAt: null,
    }
  }
}
