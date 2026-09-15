import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchActiveListingsBatch, fetchAllActiveListings, fetchListingsByItemIds } from './ebay-inventory'
import {
  extractProductIdFromCustomLabel,
  extractSourceLookupKeys,
  resolveInventoryProductId,
  type InventoryListingInput,
} from './inventory'

export interface InventorySyncResult {
  total: number
  matched: number
}

export interface InventorySyncOptions {
  signal?: AbortSignal
  writeConcurrency?: number
  // eBayからの全ページ取得に許容する合計時間。日次cron(maxDuration=300秒)
  // では既定の45秒だと数十ページの取得に足りないため引き上げて渡す。
  fetchTotalTimeoutMs?: number
}

export interface InventorySyncBatchResult extends InventorySyncResult {
  nextPage: number | null
  totalPages: number
  lastFetchedPage: number
  truncated: boolean
  ebayTotalPages: number
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

  const sourceLookupKeys = Array.from(new Set(
    uniqueListings.flatMap(listing => extractSourceLookupKeys(listing.customLabel)),
  ))
  const productIds = Array.from(new Set(
    uniqueListings.map(listing => extractProductIdFromCustomLabel(listing.customLabel)).filter((id): id is string => id !== null),
  ))
  const ebayItemIds = Array.from(new Set(uniqueListings.map(listing => listing.ebayItemId).filter(Boolean)))

  const productLookup = new Map<string, string>()
  const sourceProductLookup = new Map<string, Set<string>>()
  if (productIds.length > 0) {
    const { data: directProducts, error: directProductError } = await db
      .from('products')
      .select('id, source_item_id, ebay_item_id')
      .eq('user_id', userId)
      .in('id', productIds)
    if (directProductError) throw new Error(`Product lookup failed: ${directProductError.message}`)
    for (const product of directProducts ?? []) productLookup.set(product.id, product.id)
  }
  if (ebayItemIds.length > 0 && uniqueListings.some(listing => listing.customLabel)) {
    const { data: ebayProducts, error: ebayProductError } = await db
      .from('products')
      .select('id, source_item_id, ebay_item_id')
      .eq('user_id', userId)
      .in('ebay_item_id', ebayItemIds)
    if (ebayProductError) throw new Error(`Product lookup failed: ${ebayProductError.message}`)
    for (const product of ebayProducts ?? []) {
      if (product.ebay_item_id) productLookup.set(`ebay:${product.ebay_item_id}`, product.id)
    }
  }
  const sourceLookupKeyChunks = Array.from(
    { length: Math.ceil(sourceLookupKeys.length / DB_CHUNK_SIZE) },
    (_, index) => sourceLookupKeys.slice(index * DB_CHUNK_SIZE, (index + 1) * DB_CHUNK_SIZE),
  )
  for (const sourceLookupKeyChunk of sourceLookupKeyChunks) {
    const { data: matchedProducts, error: productError } = await db
      .from('products')
      .select('id, source_item_id, ebay_item_id')
      .eq('user_id', userId)
      .in('source_item_id', sourceLookupKeyChunk)

    if (productError) throw new Error(`Product lookup failed: ${productError.message}`)
    for (const product of matchedProducts ?? []) {
      if (!product.source_item_id) continue
      const productIdsForSource = sourceProductLookup.get(product.source_item_id) ?? new Set<string>()
      productIdsForSource.add(product.id)
      sourceProductLookup.set(product.source_item_id, productIdsForSource)
    }
  }

  // ユーザー要望: eBayアカウント上には他ツール(公式の既存ツール)で出品・
  // 在庫管理中の商品が約5,000件あり、それらをKakehashiの在庫管理に混在
  // させると運用が混乱する。Kakehashiで出品した商品(CustomLabelの
  // kakehashi_{商品ID}等から商品に紐付くもの)だけを在庫管理の対象とし、
  // 紐付かない出品は保存しない。
  const rows = uniqueListings.flatMap(listing => {
    const directProductId = extractProductIdFromCustomLabel(listing.customLabel)
    const sourceProductIds = extractSourceLookupKeys(listing.customLabel)
      .flatMap(key => Array.from(sourceProductLookup.get(key) ?? []))
    const productId = resolveInventoryProductId(
      directProductId ? productLookup.get(directProductId) : null,
      productLookup.get(`ebay:${listing.ebayItemId}`),
      sourceProductIds,
    )
    if (!productId) return []

    return [{
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
      raw_data: listing.imageUrl ? { image_url: listing.imageUrl } : null,
      product_id: productId,
      fetched_at: now,
      updated_at: now,
    }]
  })
  const matched = rows.length

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

  await applyListingStateToProducts(db, userId, rows.map(row => ({
    product_id: row.product_id,
    ebay_item_id: row.ebay_item_id,
    quantity: row.quantity,
    quantity_sold: row.quantity_sold,
  })))

  return { total: uniqueListings.length, matched }
}

export interface ProductListingStateInput {
  product_id: string
  ebay_item_id: string
  quantity: number | null
  quantity_sold?: number | null
}

// ユーザー要望: 集計カードに取り下げたリストを表示したい。
// 残数>0 → 出品中 / 残数0で販売あり → 売却済み / 残数0で販売なし → 取下げ
// (仕入先売り切れの即取り下げでeBayの数量を0にした商品は「取下げ」)。
export function resolveProductListingStatus(quantity: number | null | undefined, quantitySold: number | null | undefined): 'listed' | 'sold' | 'delisted' {
  if ((quantity ?? 0) > 0) return 'listed'
  return (quantitySold ?? 0) > 0 ? 'sold' : 'delisted'
}

// 実データで確認した不具合: 在庫管理画面の「出品中」「売却済み」の集計は
// products.listing_status を数えているが、CSV出力→eBayアップロードで出品
// した商品は products 側が draft のまま更新されず、148件をeBayから
// 取り込んでも「出品中 0」と表示されていた。eBayの出品と商品が紐付いた
// 時点で products の listing_status / ebay_item_id を更新する。
export async function applyListingStateToProducts(
  db: SupabaseClient,
  userId: string,
  listings: ProductListingStateInput[],
): Promise<void> {
  const now = new Date().toISOString()
  const byProduct = new Map<string, ProductListingStateInput>()
  for (const listing of listings) byProduct.set(listing.product_id, listing)
  const entries = Array.from(byProduct.values())
  const workerCount = Math.min(5, entries.length)
  let next = 0
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < entries.length) {
      const entry = entries[next++]
      const { error } = await db
        .from('products')
        .update({
          ebay_item_id: entry.ebay_item_id,
          listing_status: resolveProductListingStatus(entry.quantity, entry.quantity_sold),
          listed_at: now,
          updated_at: now,
        })
        .eq('user_id', userId)
        .eq('id', entry.product_id)
      if (error) throw new Error(`Product listing state update failed: ${error.message}`)
    }
  }))
}

// 終了した出品に紐付く商品は、売り切れ(残数0で販売数あり)なら「売却済み」、
// それ以外(取り下げ・期限切れ)は「取下げ」にする。
async function markProductsForEndedListings(
  db: SupabaseClient,
  userId: string,
  itemIds: string[],
): Promise<void> {
  const { data, error } = await db
    .from('inventory_active_listings')
    .select('product_id, quantity, quantity_sold')
    .eq('user_id', userId)
    .in('ebay_item_id', itemIds)
    .not('product_id', 'is', null)
  if (error) throw new Error(`Ended listing lookup failed: ${error.message}`)
  const now = new Date().toISOString()
  const soldIds: string[] = []
  const delistedIds: string[] = []
  for (const row of data ?? []) {
    const sold = (row.quantity ?? 0) <= 0 && (row.quantity_sold ?? 0) > 0
    ;(sold ? soldIds : delistedIds).push(row.product_id as string)
  }
  if (soldIds.length > 0) {
    const { error: soldError } = await db
      .from('products')
      .update({ listing_status: 'sold', sold_at: now, updated_at: now })
      .eq('user_id', userId)
      .in('id', soldIds)
    if (soldError) throw new Error(`Product sold state update failed: ${soldError.message}`)
  }
  if (delistedIds.length > 0) {
    const { error: delistError } = await db
      .from('products')
      .update({ listing_status: 'delisted', updated_at: now })
      .eq('user_id', userId)
      .in('id', delistedIds)
      .neq('listing_status', 'sold')
    if (delistError) throw new Error(`Product delisted state update failed: ${delistError.message}`)
  }
}

// 取り下げ(数量0へのRevise)を実行した出品に delisted_at を記録し、翌日以降の
// 自動取り下げで同じ出品を繰り返し対象にしないようにする。
export async function markListingsDelisted(db: SupabaseClient, userId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return
  const now = new Date().toISOString()
  for (let index = 0; index < itemIds.length; index += DB_CHUNK_SIZE) {
    const chunk = itemIds.slice(index, index + DB_CHUNK_SIZE)
    const { data: rows, error } = await db
      .from('inventory_active_listings')
      .update({ delisted_at: now, updated_at: now })
      .eq('user_id', userId)
      .in('ebay_item_id', chunk)
      .select('product_id')
    if (error) throw new Error(`Delisted flag update failed: ${error.message}`)
    // 取り下げた出品に紐付く商品は集計カードの「取下げ」に表示する
    const productIds = (rows ?? []).map(row => row.product_id as string | null).filter((id): id is string => Boolean(id))
    if (productIds.length === 0) continue
    const { error: productError } = await db
      .from('products')
      .update({ listing_status: 'delisted', updated_at: now })
      .eq('user_id', userId)
      .in('id', productIds)
    if (productError) throw new Error(`Product delisted state update failed: ${productError.message}`)
  }
}

// 以前の仕様では紐付かない出品も保存していたため、他ツールの出品が
// 在庫一覧に残っている。Kakehashi管理外の行を同期のたびに取り除く。
export async function purgeUnmanagedListings(db: SupabaseClient, userId: string): Promise<void> {
  const { error } = await db
    .from('inventory_active_listings')
    .delete()
    .eq('user_id', userId)
    .is('product_id', null)
  if (error) throw new Error(`Unmanaged listing cleanup failed: ${error.message}`)
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
  await purgeUnmanagedListings(db, userId)

  return {
    ...stored,
    nextPage: batch.nextPage,
    totalPages: batch.totalPages,
    lastFetchedPage: batch.lastFetchedPage,
    truncated: batch.truncated,
    ebayTotalPages: batch.ebayTotalPages,
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
    { signal: options.signal, totalTimeoutMs: options.fetchTotalTimeoutMs },
  )
  const stored = await storeInventoryListings(db, userId, listings, options)
  await purgeUnmanagedListings(db, userId)
  return stored
}

// ---------------------------------------------------------------------------
// Kakehashiが出品したItemIDだけを個別照会する同期
//
// ユーザー要望・実データで確認した不具合: eBayアカウント上には他ツールで
// 出品中の商品が約1万件あり、全active出品を走査する従来方式では上限・
// 実行時間の制約で最後まで走り切れず、Kakehashiで出品した149件が1件も
// 同期できなかった。Kakehashiが把握しているItemID(在庫一覧に登録済みの
// 出品 + 直接出品で得たebay_item_id)だけをGetItemで個別に照会する方式に
// 変更し、他ツールの出品数に左右されないようにする。
//
// 新しく出品された商品の発見: eBay側の全active出品を新しい順に並べた
// 先頭2ページ(400件)だけを追加で確認し、Kakehashiの商品に紐付く出品が
// あれば取り込む(Kakehashiの出品は直近のものが多いため、ここに含まれる
// 可能性が高い。含まれない場合はCSV取込で登録できる)。
// ---------------------------------------------------------------------------

const DISCOVERY_PAGES = 2

export interface KnownInventorySyncBatchResult {
  // 照会対象のKakehashi出品の総数
  totalItems: number
  // このバッチまでに照会し終えた件数
  processedItems: number
  // このバッチで最新情報に更新した件数
  updated: number
  // このバッチで終了済みとして在庫一覧から除外した件数
  ended: number
  // 新規に発見して取り込んだ件数(最初のバッチのみ)
  discovered: number
  nextBatch: number | null
  totalBatches: number
}

export interface KnownInventorySyncResult {
  total: number
  matched: number
  ended: number
  discovered: number
}

// Kakehashiが把握しているeBay ItemIDを集める(在庫一覧 + 商品テーブル)。
async function collectKnownItemIds(db: SupabaseClient, userId: string): Promise<string[]> {
  const ids = new Set<string>()

  const { data: listings, error: listingError } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id')
    .eq('user_id', userId)
    .not('product_id', 'is', null)
  if (listingError) throw new Error(`Known listing lookup failed: ${listingError.message}`)
  for (const row of listings ?? []) if (row.ebay_item_id) ids.add(String(row.ebay_item_id))

  const { data: products, error: productError } = await db
    .from('products')
    .select('ebay_item_id')
    .eq('user_id', userId)
    .not('ebay_item_id', 'is', null)
  if (productError) throw new Error(`Product listing lookup failed: ${productError.message}`)
  for (const row of products ?? []) if (row.ebay_item_id) ids.add(String(row.ebay_item_id))

  return Array.from(ids).sort()
}

// 新しい順の先頭数ページだけを見て、Kakehashiの商品に紐付く新規出品を取り込む。
// 発見処理の失敗で同期全体を止めない(既知の出品の更新は続行する)。
async function discoverNewListings(
  db: SupabaseClient,
  userId: string,
  accessToken: string,
  options: InventorySyncOptions,
): Promise<number> {
  try {
    const batch = await fetchActiveListingsBatch(
      { accessToken },
      1,
      DISCOVERY_PAGES,
      { signal: options.signal },
    )
    const stored = await storeInventoryListings(db, userId, batch.items, options)
    return stored.matched
  } catch (error) {
    if (options.signal?.aborted) throw error
    console.warn('[inventory-sync] discovery of new listings failed:', error instanceof Error ? error.message : error)
    return 0
  }
}

async function removeEndedListings(db: SupabaseClient, userId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return
  for (let index = 0; index < itemIds.length; index += DB_CHUNK_SIZE) {
    const chunk = itemIds.slice(index, index + DB_CHUNK_SIZE)
    await markProductsForEndedListings(db, userId, chunk)
    const { error } = await db
      .from('inventory_active_listings')
      .delete()
      .eq('user_id', userId)
      .in('ebay_item_id', chunk)
    if (error) throw new Error(`Ended listing cleanup failed: ${error.message}`)
  }
}

/**
 * Kakehashiが把握している出品を、batchSize件ずつGetItemで個別照会して更新する
 * (手動同期用。1リクエストで1バッチを処理し、cursorで続きを再開できる)。
 */
export async function syncKnownInventoryListingBatch(
  db: SupabaseClient,
  userId: string,
  accessToken: string,
  batchIndex: number,
  batchSize: number,
  options: InventorySyncOptions = {},
): Promise<KnownInventorySyncBatchResult> {
  if (!Number.isInteger(batchIndex) || batchIndex < 1) throw new Error(`Invalid inventory sync batch: ${batchIndex}`)
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`Invalid inventory sync batch size: ${batchSize}`)

  const discovered = batchIndex === 1
    ? await discoverNewListings(db, userId, accessToken, options)
    : 0

  const knownIds = await collectKnownItemIds(db, userId)
  const totalBatches = Math.max(1, Math.ceil(knownIds.length / batchSize))
  const start = (batchIndex - 1) * batchSize
  const targetIds = knownIds.slice(start, start + batchSize)

  const fetched = await fetchListingsByItemIds(
    { accessToken },
    targetIds,
    { signal: options.signal, totalTimeoutMs: options.fetchTotalTimeoutMs },
  )
  const stored = await storeInventoryListings(db, userId, fetched.items, options)
  await removeEndedListings(db, userId, fetched.endedItemIds)
  await purgeUnmanagedListings(db, userId)

  const processedItems = Math.min(knownIds.length, start + targetIds.length)
  return {
    totalItems: knownIds.length,
    processedItems,
    updated: stored.matched,
    ended: fetched.endedItemIds.length,
    discovered,
    nextBatch: batchIndex < totalBatches ? batchIndex + 1 : null,
    totalBatches,
  }
}

/**
 * Kakehashiが把握している出品をすべて個別照会して更新する(日次cron用)。
 */
export async function syncKnownInventoryListings(
  db: SupabaseClient,
  userId: string,
  accessToken: string,
  options: InventorySyncOptions = {},
): Promise<KnownInventorySyncResult> {
  const discovered = await discoverNewListings(db, userId, accessToken, options)
  const knownIds = await collectKnownItemIds(db, userId)

  const fetched = await fetchListingsByItemIds(
    { accessToken },
    knownIds,
    { signal: options.signal, totalTimeoutMs: options.fetchTotalTimeoutMs },
  )
  const stored = await storeInventoryListings(db, userId, fetched.items, options)
  await removeEndedListings(db, userId, fetched.endedItemIds)
  await purgeUnmanagedListings(db, userId)

  return {
    total: knownIds.length,
    matched: stored.matched,
    ended: fetched.endedItemIds.length,
    discovered,
  }
}
