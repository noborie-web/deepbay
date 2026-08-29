import * as cheerio from 'cheerio'
import { BaseScraper } from './base'
import type { ScrapedProduct } from './types'

interface VectorParkOffer {
  price?: string | number
  itemCondition?: string[] | string
  availability?: string
}

interface VectorParkProductJsonLd {
  name?: string
  description?: string[] | string
  image?: string[] | string
  brand?: { name?: string }
  offers?: VectorParkOffer
}

export class VectorParkScraper extends BaseScraper {
  name = 'ベクトルパーク'
  siteKey = 'vector_park'
  urlPattern = /vector-park\.jp\/item\/[^/]+\/?/

  parse($: cheerio.CheerioAPI, url: string): ScrapedProduct {
    const itemId = url.match(/\/item\/([^/]+)\/?/)?.[1] ?? null

    const jsonLdBlocks = $('script[type="application/ld+json"]').toArray()
    const data: VectorParkProductJsonLd | undefined = jsonLdBlocks
      .map((el): VectorParkProductJsonLd | null => {
        try {
          const parsed = JSON.parse($(el).text())
          const candidate = Array.isArray(parsed) ? parsed[0] : parsed
          return candidate?.['@type'] === 'Product' ? (candidate as VectorParkProductJsonLd) : null
        } catch {
          return null
        }
      })
      .find((candidate): candidate is VectorParkProductJsonLd => candidate !== null)

    const title = data?.name?.trim() || $('title').first().text().split('|')[0].trim()

    const priceRaw = data?.offers?.price
    const price = priceRaw != null ? parseInt(String(priceRaw), 10) || null : null

    const descriptionValue = data?.description
    const description = Array.isArray(descriptionValue)
      ? descriptionValue.join('\n')
      : (descriptionValue ?? '')

    const imageValue = data?.image
    const images = Array.isArray(imageValue) ? imageValue : (imageValue ? [imageValue] : [])

    const conditionValue = data?.offers?.itemCondition
    const condition = Array.isArray(conditionValue) ? (conditionValue[0] ?? null) : (conditionValue ?? null)

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
