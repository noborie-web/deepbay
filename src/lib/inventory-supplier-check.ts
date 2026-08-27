import type { SupabaseClient } from '@supabase/supabase-js'
import { findScraper, scrapeUrl } from '@/lib/scrapers'

interface SupplierListingRow {
  id: string
  product_id: string
}

interface SupplierProductRow {
  id: string
  source_url: string | null
}

export interface SupplierCheckResult {
  total: number
  available: number
  unavailable: number
  skipped: number
  failed: number
}

export async function checkSupplierListings(
  db: SupabaseClient,
  userId: string,
  batchLimit = 50,
): Promise<SupplierCheckResult> {
  const result: SupplierCheckResult = {
    total: 0,
    available: 0,
    unavailable: 0,
    skipped: 0,
    failed: 0,
  }

  const { data: listings, error: listingsError } = await db
    .from('inventory_active_listings')
    .select('id, product_id')
    .eq('user_id', userId)
    .not('product_id', 'is', null)
    .gt('quantity', 0)
    .order('supplier_checked_at', { ascending: true, nullsFirst: true })
    .limit(batchLimit)

  if (listingsError) {
    throw new Error(`Supplier listing lookup failed: ${listingsError.message}`)
  }

  const targets = (listings ?? []) as SupplierListingRow[]
  result.total = targets.length
  if (targets.length === 0) return result

  const productIds = Array.from(new Set(targets.map(listing => listing.product_id)))
  const { data: products, error: productsError } = await db
    .from('products')
    .select('id, source_url')
    .eq('user_id', userId)
    .in('id', productIds)

  if (productsError) {
    throw new Error(`Supplier product lookup failed: ${productsError.message}`)
  }

  const productMap = new Map(
    ((products ?? []) as SupplierProductRow[]).map(product => [product.id, product]),
  )

  for (const listing of targets) {
    const checkedAt = new Date().toISOString()
    const sourceUrl = productMap.get(listing.product_id)?.source_url ?? null
    let outcome: 'available' | 'unavailable' | 'skipped' = 'skipped'
    let quantity: number | undefined

    if (sourceUrl && findScraper(sourceUrl)) {
      try {
        const scrapedProducts = await scrapeUrl(sourceUrl, { limit: 1 })
        if (scrapedProducts.some(product => product.availability === 'sold_out')) {
          outcome = 'unavailable'
          quantity = 0
        } else {
          outcome = 'available'
        }
      } catch {
        // 商品詳細を再取得できない場合は、仕入れ元ページの削除として扱う。
        outcome = 'unavailable'
        quantity = 0
      }
    }

    const update: { supplier_checked_at: string; quantity?: number } = {
      supplier_checked_at: checkedAt,
    }
    if (quantity !== undefined) update.quantity = quantity

    try {
      const { error: updateError } = await db
        .from('inventory_active_listings')
        .update(update)
        .eq('user_id', userId)
        .eq('id', listing.id)
      if (updateError) throw new Error(updateError.message)
      result[outcome] += 1
    } catch {
      // 1件の更新失敗で、残りの仕入れ元チェックを中断しない。
      result.failed += 1
    }
  }

  return result
}
