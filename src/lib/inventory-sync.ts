import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchActiveListingsBatch, fetchAllActiveListings } from './ebay-inventory'
import { extractSourceLookupCode, type InventoryListingInput } from './inventory'

export interface InventorySyncResult {
  total: number
  matched: number
}

export interface InventorySyncOptions {
  signal?: AbortSignal
  writeConcurrency?: number
}

export interface InventorySyncBatchResult extends InventorySyncResult {
  nextPage: number | null
  totalPages: number
  lastFetchedPage: number
}

const DB_CHUNK_SIZE = 100

async function storeInventoryListings(
  db: SupabaseClient,
  userId: string,
  listings: InventoryListingInput[],
  options: InventorySyncOptions = {},
): Promise<InventorySyncResult> {
  // eBay pagination can briefly overlap while active listings are changing.
  // PostgreSQL upsert rejects duplicate conflict keys in the same statement,
  // so keep the latest occurrence of each item before building write chunks.
  const uniqueListings = Array.from(new Map(
    listings
      .filter(listing => listing.ebayItemId)
      .map(listing => [listing.ebayItemId, listing]),
  ).values())
  const now = new Date().toISOString()

  const managementCodes = Array.from(new Set(
    uniqueListings
      .map(listing => extractSourceLookupCode(listing.customLabel))
      .filter((code): code is string => code !== null),
  ))

  const productLookup = new Map<string, string>()
  const managementCodeChunks = Array.from(
    { length: Math.ceil(managementCodes.length / DB_CHUNK_SIZE) },
    (_, index) => managementCodes.slice(index * DB_CHUNK_SIZE, (index + 1) * DB_CHUNK_SIZE),
  )
  for (const managementCodeChunk of managementCodeChunks) {
    const { data: matchedProducts, error: productError } = await db
      .from('products')
      .select('id, source_item_id')
      .eq('user_id', userId)
      .in('source_item_id', managementCodeChunk)

    if (productError) throw new Error(`Product lookup failed: ${productError.message}`)
    for (const product of matchedProducts ?? []) {
      if (product.source_item_id) productLookup.set(product.source_item_id, product.id)
    }
  }

  let matched = 0
  const rows = uniqueListings.map(listing => {
    const code = extractSourceLookupCode(listing.customLabel)
    const productId = code ? (productLookup.get(code) ?? null) : null
    if (productId) matched++

    return {
      user_id: userId,
      ebay_item_id: listing.ebayItemId,
      custom_label: listing.customLabel,
      title: listing.title,
      current_price: listing.currentPrice,
      quantity: listing.quantity,
      quantity_sold: listing.quantitySold,
      listing_status: listing.listingStatus,
      start_time: listing.startTime,
      end_time: listing.endTime,
      product_id: productId,
      fetched_at: now,
      updated_at: now,
    }
  })

  const chunks = Array.from(
    { length: Math.ceil(rows.length / DB_CHUNK_SIZE) },
    (_, index) => rows.slice(index * DB_CHUNK_SIZE, (index + 1) * DB_CHUNK_SIZE),
  )
  let nextChunk = 0
  const workerCount = Math.min(
    Math.max(1, Math.floor(options.writeConcurrency ?? 4)),
    chunks.length,
  )

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextChunk < chunks.length) {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error('Inventory sync aborted')
      }
      const chunk = chunks[nextChunk++]
      const { error } = await db
        .from('inventory_active_listings')
        .upsert(chunk, { onConflict: 'user_id,ebay_item_id' })
      if (error) throw new Error(`Inventory listing upsert failed: ${error.message}`)
    }
  }))

  return { total: uniqueListings.length, matched }
}

export async function syncInventoryListingBatch(
  db: SupabaseClient,
  userId: string,
  accessToken: string,
  startPage: number,
  pageCount: number,
  options: InventorySyncOptions = {},
): Promise<InventorySyncBatchResult> {
  const batch = await fetchActiveListingsBatch(
    { accessToken },
    startPage,
    pageCount,
    { signal: options.signal },
  )
  const stored = await storeInventoryListings(db, userId, batch.items, options)

  return {
    ...stored,
    nextPage: batch.nextPage,
    totalPages: batch.totalPages,
    lastFetchedPage: batch.lastFetchedPage,
  }
}

export async function syncInventoryListings(
  db: SupabaseClient,
  userId: string,
  accessToken: string,
  options: InventorySyncOptions = {},
): Promise<InventorySyncResult> {
  const listings = await fetchAllActiveListings(
    { accessToken },
    { signal: options.signal },
  )
  return storeInventoryListings(db, userId, listings, options)
}
