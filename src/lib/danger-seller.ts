export interface SellerIdentity {
  sellerId?: string | null
  sellerUrl?: string | null
  sourceSite?: string | null
}

function normalizeId(value: string | null | undefined): string | null {
  const normalized = value?.normalize('NFKC').trim().toLowerCase()
  return normalized || null
}

export function normalizeSellerUrl(value: string): string {
  const trimmed = value.normalize('NFKC').trim()
  if (!trimmed) return ''

  try {
    const parsed = new URL(trimmed)
    return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return trimmed.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
  }
}

export function sellerIdFromUrl(value: string): string | null {
  const normalized = normalizeSellerUrl(value)
  if (!normalized) return null

  const patterns = [
    /\/user\/profile\/([^/]+)$/i,
    /\/s\/([^/]+)$/i,
    /\/seller\/([^/]+)$/i,
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) return normalizeId(decodeURIComponent(match[1]))
  }
  return null
}

function sellerSiteFromUrl(value: string | null | undefined): string | null {
  if (!value) return null

  try {
    const hostname = new URL(value.normalize('NFKC').trim()).hostname.toLowerCase()
    if (hostname === 'jp.mercari.com' || hostname.endsWith('.mercari.com')) return 'mercari'
    if (hostname === 'auctions.yahoo.co.jp') return 'yahoo_auctions'
    return hostname || null
  } catch {
    return null
  }
}

function normalizeSourceSite(value: string | null | undefined): string | null {
  const normalized = normalizeId(value)
  if (!normalized) return null
  if (normalized === 'yahoo' || normalized === 'yahoo_auction') return 'yahoo_auctions'
  return normalized
}

export function matchesDangerSeller(
  product: SellerIdentity,
  registeredSellerUrls: string[],
): boolean {
  const productId = normalizeId(product.sellerId) ?? (
    product.sellerUrl ? sellerIdFromUrl(product.sellerUrl) : null
  )
  const productUrl = product.sellerUrl ? normalizeSellerUrl(product.sellerUrl) : ''
  const productSite = sellerSiteFromUrl(product.sellerUrl)
    ?? normalizeSourceSite(product.sourceSite)

  return registeredSellerUrls.some((registered) => {
    const registeredSite = sellerSiteFromUrl(registered)
    // 共通CSVに複数サイトのURLを混在できるよう、別サイト同士は照合しない。
    if (productSite && registeredSite && productSite !== registeredSite) return false

    const registeredId = sellerIdFromUrl(registered)
    if (productId && registeredId && productId === registeredId) return true

    const registeredUrl = normalizeSellerUrl(registered)
    return Boolean(
      productUrl
      && registeredUrl
      && (productUrl === registeredUrl || productUrl.startsWith(`${registeredUrl}/`)),
    )
  })
}
