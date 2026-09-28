import type { SupabaseClient } from '@supabase/supabase-js'
import { EbayCallLimitError, fetchActiveListingsBatch, fetchAllActiveListings, fetchListingsByItemIds, scanSellerListByStartTime, SELLER_LIST_MAX_RANGE_MS } from './ebay-inventory'
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
  // 新規出品の発見(GetSellerListの期間走査)に許容する時間
  discoveryTimeBudgetMs?: number
  // GetItem個別照会の並行数(既定4。日次cronでは件数が多いため上げる)
  getItemConcurrency?: number
  // ユーザー要望(出品1,000件超への備え): 1回の実行で照会する件数の上限と、
  // 前回の続きから再開するための位置(最後に照会したItemID)。
  // 実行時間(Vercel 300秒)に収まらない規模でも、複数回に分けて全件を巡回できる。
  maxItemsPerRun?: number
  cursorItemId?: string | null
  // ユーザー要望(2026-09-25): 出品アカウントを複数運用する。同期は必ず
  // 「どのセラーの出品か」を指定して行い、他セラーの出品には触れない。
  sellerAccountId?: string | null
  // このセラーが出品しているサイト(US/UK/AU)。新規出品の発見はサイトごとに
  // 走らせないと、UK/AUに出した出品が見つからない。
  sellerSiteIds?: string[] | null
  // 出品アカウント未設定の古い抽出(extractions.seller_account_id が null)の
  // 商品を、このセラーのものとして扱う(最初に接続したセラーのみ true)。
  ownsUnassignedProducts?: boolean
  // 本番で確認した不具合(2026-09-26): 手動同期を1日に7回実行して GetItem が
  // eBayの日次上限を超えた。直近に取得済みの出品は再照会しない(手動同期用)。
  skipFetchedWithinMs?: number
  // ユーザー要望(2026-09-27): 695件の更新に695回のGetItemを使っていたため、
  // eBayの日次上限をすぐ使い切っていた。GetMyeBaySelling(1回200件)でまとめて
  // 取得し、一覧に無かった出品だけを個別確認する(約30回で済む)。
  bulkRefresh?: boolean
  // 一覧に無かった出品を個別確認する上限(残りは次回に回す)
  maxMissingChecksPerRun?: number
}

export interface InventorySyncBatchResult extends InventorySyncResult {
  nextPage: number | null
  totalPages: number
  lastFetchedPage: number
  truncated: boolean
  ebayTotalPages: number
}

const DB_CHUNK_SIZE = 100

// .in(...) に渡すIDが多すぎるとURLが長くなりすぎて 400 Bad Request になるため、
// 一定件数ずつに分割する。
function chunked<T>(items: T[], size = DB_CHUNK_SIZE): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
}

export async function storeInventoryListings(
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
  // 本番で確認した不具合(2026-09-24): 出品が700件規模になり、IDをまとめて
  // .in(...) で照会するとURLが長すぎて PostgREST が 400 Bad Request を返し、
  // 日次の同期が「Product lookup failed: Bad Request」で失敗していた。
  // 他の書き込みと同じく DB_CHUNK_SIZE 件ずつに分割して照会する。
  if (productIds.length > 0) {
    for (const chunk of chunked(productIds)) {
      const { data: directProducts, error: directProductError } = await db
        .from('products')
        .select('id, source_item_id, ebay_item_id')
        .eq('user_id', userId)
        .in('id', chunk)
      if (directProductError) throw new Error(`Product lookup failed: ${directProductError.message}`)
      for (const product of directProducts ?? []) productLookup.set(product.id, product.id)
    }
  }
  if (ebayItemIds.length > 0 && uniqueListings.some(listing => listing.customLabel)) {
    for (const chunk of chunked(ebayItemIds)) {
      const { data: ebayProducts, error: ebayProductError } = await db
        .from('products')
        .select('id, source_item_id, ebay_item_id')
        .eq('user_id', userId)
        .in('ebay_item_id', chunk)
      if (ebayProductError) throw new Error(`Product lookup failed: ${ebayProductError.message}`)
      for (const product of ebayProducts ?? []) {
        if (product.ebay_item_id) productLookup.set(`ebay:${product.ebay_item_id}`, product.id)
      }
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

    // サイト・通貨はeBayから取得できたときだけ更新する(取得できない回に
    // 既定値のUS/USDで上書きしてUK/AU出品を取り違えないため)。
    const site = listing.siteId && listing.currency
      ? { site_id: listing.siteId, currency: listing.currency }
      : {}

    return [{
      ...site,
      ...(options.sellerAccountId ? { seller_account_id: options.sellerAccountId } : {}),
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
  const now = new Date().toISOString()
  const soldIds: string[] = []
  const delistedIds: string[] = []
  for (const itemChunk of chunked(itemIds)) {
    const { data, error } = await db
      .from('inventory_active_listings')
      .select('product_id, quantity, quantity_sold')
      .eq('user_id', userId)
      .in('ebay_item_id', itemChunk)
      .not('product_id', 'is', null)
    if (error) throw new Error(`Ended listing lookup failed: ${error.message}`)
    for (const row of data ?? []) {
      const sold = (row.quantity ?? 0) <= 0 && (row.quantity_sold ?? 0) > 0
      ;(sold ? soldIds : delistedIds).push(row.product_id as string)
    }
  }
  for (const chunk of chunked(soldIds)) {
    const { error: soldError } = await db
      .from('products')
      .update({ listing_status: 'sold', sold_at: now, updated_at: now })
      .eq('user_id', userId)
      .in('id', chunk)
    if (soldError) throw new Error(`Product sold state update failed: ${soldError.message}`)
  }
  for (const chunk of chunked(delistedIds)) {
    const { error: delistError } = await db
      .from('products')
      .update({ listing_status: 'delisted', updated_at: now })
      .eq('user_id', userId)
      .in('id', chunk)
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

// 価格改定をeBayに反映したら、在庫一覧の現在価格も更新する。
// 本番で確認した不具合(2026-09-22): 反映後も current_price が古いままで、次回同期
// まで「価格改定対象 116件」が消えず、確認画面にも反映済みの商品が並び続けた。
export async function applyRevisedPrices(
  db: SupabaseClient,
  userId: string,
  // jpy_per_currency: UK/AU出品の換算に使った円レート(次回の比較・確認用)
  revised: Array<{ ebay_item_id: string; price: number; jpy_per_currency?: number | null }>,
): Promise<void> {
  const now = new Date().toISOString()
  for (const { ebay_item_id, price, jpy_per_currency } of revised) {
    const { error } = await db
      .from('inventory_active_listings')
      .update({
        current_price: price,
        ...(jpy_per_currency ? { pricing_jpy_per_currency: jpy_per_currency } : {}),
        updated_at: now,
      })
      .eq('user_id', userId)
      .eq('ebay_item_id', ebay_item_id)
    if (error) throw new Error(`Revised price update failed: ${error.message}`)
  }
}

// 取り下げの取り消し: 在庫を戻した出品の delisted_at を外し、商品を出品中に戻す。
// 次回の仕入先チェックで改めて売り切れ判定される。
export async function markListingsRestored(db: SupabaseClient, userId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return
  const now = new Date().toISOString()
  for (let index = 0; index < itemIds.length; index += DB_CHUNK_SIZE) {
    const chunk = itemIds.slice(index, index + DB_CHUNK_SIZE)
    const { data: rows, error } = await db
      .from('inventory_active_listings')
      .update({ delisted_at: null, quantity: 1, supplier_checked_at: null, updated_at: now })
      .eq('user_id', userId)
      .in('ebay_item_id', chunk)
      .select('product_id')
    if (error) throw new Error(`Restore flag update failed: ${error.message}`)
    const productIds = (rows ?? []).map(row => row.product_id as string | null).filter((id): id is string => Boolean(id))
    if (productIds.length === 0) continue
    const { error: productError } = await db
      .from('products')
      .update({ listing_status: 'listed', updated_at: now })
      .eq('user_id', userId)
      .in('id', productIds)
    if (productError) throw new Error(`Product restore state update failed: ${productError.message}`)
  }
}

// 以前の仕様では紐付かない出品も保存していたため、他ツールの出品が
// 在庫一覧に残っている。Kakehashi管理外の行を同期のたびに取り除く。
export async function purgeUnmanagedListings(
  db: SupabaseClient,
  userId: string,
  sellerAccountId?: string | null,
): Promise<void> {
  let query = db
    .from('inventory_active_listings')
    .delete()
    .eq('user_id', userId)
    .is('product_id', null)
  // 他セラーの出品を巻き込んで消さない
  if (sellerAccountId) query = query.eq('seller_account_id', sellerAccountId)
  const { error } = await query
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
  await purgeUnmanagedListings(db, userId, options.sellerAccountId)

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
  await purgeUnmanagedListings(db, userId, options.sellerAccountId)
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
// 新しく出品された商品の発見: 以前はeBay側の全active出品を新しい順に
// 並べた先頭400件だけを確認していたが、他ツールの出品が多いとCSVで出品
// したKakehashiの商品が押し出されて下書きのまま残った(実データで11件)。
// GetSellerListで「前回走査した時刻以降に出品開始されたもの」を全件確認する
// 方式に変更し、出品数の多寡に関わらず確実に発見する。
// ---------------------------------------------------------------------------

// 前回走査時刻からの重なり(eBay側の反映遅れを吸収する)
const DISCOVERY_OVERLAP_MS = 2 * 60 * 60 * 1000
// 1回の走査区間
const DISCOVERY_CHUNK_MS = 24 * 60 * 60 * 1000
// 走査時刻の記録がない場合に遡る期間。
// 本番で確認した不具合(2026-09-26): 新しく追加したセラー(akebono-32)は30日分を
// 1日ずつ走査することになり、時間予算内に1区間も終わらず走査位置が進まなかった。
// 新しいセラーで取り込みたいのは直近にアップロードした出品なので、初回は
// 短い期間だけ見る(必要ならItemIDの手動紐付けで補える)。
const DISCOVERY_DEFAULT_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000
const DEFAULT_DISCOVERY_TIME_BUDGET_MS = 20_000

export interface DiscoveryResult {
  discovered: number
  // 期間内の出品を読み切れなかった(次回同期で同じ期間から再走査する)
  truncated: boolean
  // 本番で確認した不具合(2026-09-26): akebono-32(UK/AU)の新規出品が取り込まれず、
  // 原因はconsole.warnにしか出ていなかったため画面からもDBからも見えなかった。
  // 失敗した理由を呼び出し側に返し、実行履歴に残せるようにする。
  error?: string
}

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
  discoveryTruncated: boolean
  discoveryError?: string
  // 本番で確認した不具合(2026-09-27): 1人目のセラーのGetItemが呼び出し上限で
  // 失敗すると同期全体が止まり、2人目(akebono-32)の新規出品の発見まで
  // たどり着けなかった。上限は既存出品の照会だけの問題なので、上限に当たった
  // ことを返して次のセラーへ進められるようにする。
  callLimited?: boolean
  bulkItems?: number
  bulkComplete?: boolean
  bulkError?: string
  nextBatch: number | null
  totalBatches: number
}

export interface KnownInventorySyncResult {
  total: number
  matched: number
  ended: number
  discovered: number
  discoveryTruncated: boolean
  discoveryError?: string
  // 呼び出し上限に当たって既存出品の照会をスキップした
  callLimited?: boolean
  // 出品一覧(GetMyeBaySelling)の取得結果(取り込まれない原因の切り分け用)
  bulkItems?: number
  bulkComplete?: boolean
  bulkError?: string
  // 今回照会した件数と、続きから再開するための位置(全件終わったら null)
  processed: number
  nextCursorItemId: string | null
}

// Kakehashiが把握しているeBay ItemIDを集める(在庫一覧 + 商品テーブル)。
async function collectKnownItemIds(
  db: SupabaseClient,
  userId: string,
  options: InventorySyncOptions = {},
): Promise<string[]> {
  const ids = new Set<string>()
  const sellerAccountId = options.sellerAccountId ?? null

  let listingQuery = db
    .from('inventory_active_listings')
    .select('ebay_item_id, fetched_at')
    .eq('user_id', userId)
    .not('product_id', 'is', null)
  // 他セラーのItemIDを自分のトークンで照会すると、取得できない/別の内容が
  // 返るため、必ずこのセラーの出品だけを対象にする。
  if (sellerAccountId) listingQuery = listingQuery.eq('seller_account_id', sellerAccountId)
  // 直近に取得済みの出品は再照会しない(eBayの呼び出し上限を使い切らないため)
  if (options.skipFetchedWithinMs && options.skipFetchedWithinMs > 0) {
    listingQuery = listingQuery.lt('fetched_at', new Date(Date.now() - options.skipFetchedWithinMs).toISOString())
  }
  const { data: listings, error: listingError } = await listingQuery
  if (listingError) throw new Error(`Known listing lookup failed: ${listingError.message}`)
  for (const row of listings ?? []) if (row.ebay_item_id) ids.add(String(row.ebay_item_id))

  // まだ在庫一覧に入っていない出品(ダイレクト出品直後など)は、商品が属する
  // 抽出の出品セラーでこのセラーのものかを判定する。
  const extractionIds = sellerAccountId ? await extractionIdsForSeller(db, userId, sellerAccountId, options) : null
  if (extractionIds !== null && extractionIds.length === 0) return Array.from(ids).sort()

  const productIds = new Set<string>()
  for (const chunk of extractionIds ? chunked(extractionIds) : [null]) {
    let productQuery = db
      .from('products')
      .select('ebay_item_id')
      .eq('user_id', userId)
      .not('ebay_item_id', 'is', null)
    if (chunk) productQuery = productQuery.in('extraction_id', chunk)
    const { data: products, error: productError } = await productQuery
    if (productError) throw new Error(`Product listing lookup failed: ${productError.message}`)
    for (const row of products ?? []) if (row.ebay_item_id) productIds.add(String(row.ebay_item_id))
  }
  for (const id of productIds) ids.add(id)

  return Array.from(ids).sort()
}

// このセラーで出品した抽出のID。出品セラー未設定(古い抽出)は、最初に接続した
// セラーのものとして扱う(ownsUnassignedProducts)。
async function extractionIdsForSeller(
  db: SupabaseClient,
  userId: string,
  sellerAccountId: string,
  options: InventorySyncOptions,
): Promise<string[]> {
  const { data, error } = await db
    .from('extractions')
    .select('id, seller_account_id')
    .eq('user_id', userId)
  if (error) throw new Error(`Extraction lookup failed: ${error.message}`)
  return (data ?? [])
    .filter(row => row.seller_account_id === sellerAccountId
      || (row.seller_account_id === null && options.ownsUnassignedProducts === true))
    .map(row => row.id as string)
}

// ---------------------------------------------------------------------------
// 既存出品の一括更新(GetMyeBaySelling)
//
// ユーザー要望・本番で確認した問題(2026-09-27): 695件の更新に695回のGetItemを
// 使っていたため、eBayアプリの日次呼び出し上限をすぐ使い切り、同期も新規出品の
// 発見も止まっていた。GetMyeBaySellingは1回で200件返すため、同じ695件を
// 約30回で更新できる。一覧に無かった出品(売却・終了の可能性)だけ、従来どおり
// GetItemで個別に確認する。
// ---------------------------------------------------------------------------
const DEFAULT_MISSING_CHECKS_PER_RUN = 100

// Kakehashiが出品したもの(CustomLabelが kakehashi_/deepbay_ 由来)かどうか。
// 出品一覧には他ツールの出品も含まれるため、保存処理に回す前にここで絞る。
function hasKakehashiLabel(customLabel: string | null | undefined): boolean {
  if (!customLabel) return false
  return extractProductIdFromCustomLabel(customLabel) !== null
    || extractSourceLookupKeys(customLabel).length > 0
}

async function fetchActiveListingMap(
  accessToken: string,
  siteIds: string[],
  options: InventorySyncOptions,
): Promise<{ map: Map<string, InventoryListingInput>; complete: boolean }> {
  const map = new Map<string, InventoryListingInput>()
  let complete = true
  const sites = siteIds.length > 0 ? siteIds : [null]
  // 本番で確認した不具合(2026-09-28): 予算をサイト数で均等割りした結果、
  // 応答の遅いセラー(akebono-32)は12.5秒では1ページも取れず
  // 「exceeded 12500ms」で毎回失敗していた。均等割りをやめ、先頭のサイトから
  // 残り時間を使い切る形にする(全部失敗するより、1サイトでも取り込めた方がよい。
  // 残りのサイトは次回の同期で取り込む)。
  const startedAt = Date.now()
  const budgetMs = options.fetchTotalTimeoutMs
  for (const siteId of sites) {
    const remaining = budgetMs ? budgetMs - (Date.now() - startedAt) : undefined
    if (remaining !== undefined && remaining < 8_000) { complete = false; break }
    try {
      const batch = await fetchActiveListingsBatch({ accessToken }, 1, 50, {
        signal: options.signal,
        totalTimeoutMs: remaining,
        // 本番で確認した不具合(2026-09-28): 全体予算を増やしても、1ページの
        // 上限(既定10秒)で「page 1 exceeded 10000ms」となり取得できなかった。
        // 応答の遅いセラーに合わせて1ページの上限も伸ばす。
        pageTimeoutMs: remaining ? Math.max(10_000, Math.min(25_000, remaining - 3_000)) : 25_000,
        concurrency: options.getItemConcurrency,
        siteId,
      })
      for (const item of batch.items) if (item.ebayItemId) map.set(item.ebayItemId, item)
      if (batch.truncated || batch.nextPage !== null) complete = false
    } catch (error) {
      // 1サイトが取れなくても、取れたサイトの分は活かす
      complete = false
      if (map.size === 0) throw error
      console.warn(`[inventory-sync] active list failed for site ${siteId ?? 'US'}:`, error instanceof Error ? error.message : error)
    }
  }
  return { map, complete }
}

// 前回走査した時刻以降に出品開始された出品を全件確認し、Kakehashiの商品に
// 紐付く新規出品を取り込む。発見処理の失敗で同期全体を止めない。
async function discoverNewListings(
  db: SupabaseClient,
  userId: string,
  accessToken: string,
  options: InventorySyncOptions,
): Promise<DiscoveryResult> {
  const scanStartedAt = new Date()
  try {
    // 走査位置はセラーごとに持つ(アカウントを追加したときに、既存セラーの
    // 走査位置を新しいセラーで進めてしまわないため)。
    const sellerAccountId = options.sellerAccountId ?? null
    const { data: settings, error: settingsError } = sellerAccountId
      ? await db
        .from('seller_accounts')
        .select('inventory_discovery_scanned_until')
        .eq('id', sellerAccountId)
        .eq('user_id', userId)
        .maybeSingle()
      : await db
        .from('inventory_settings')
        .select('discovery_scanned_until')
        .eq('user_id', userId)
        .maybeSingle()
    if (settingsError) throw new Error(settingsError.message)

    const scannedUntilValue = sellerAccountId
      ? (settings as { inventory_discovery_scanned_until?: string | null } | null)?.inventory_discovery_scanned_until
      : (settings as { discovery_scanned_until?: string | null } | null)?.discovery_scanned_until
    const scannedUntil = scannedUntilValue ? new Date(scannedUntilValue) : null
    let from = scannedUntil
      ? new Date(scannedUntil.getTime() - DISCOVERY_OVERLAP_MS)
      : new Date(scanStartedAt.getTime() - DISCOVERY_DEFAULT_LOOKBACK_MS)
    if (scanStartedAt.getTime() - from.getTime() > SELLER_LIST_MAX_RANGE_MS) {
      from = new Date(scanStartedAt.getTime() - SELLER_LIST_MAX_RANGE_MS)
    }

    // 期間を1日ずつに区切って走査し、読み切れた区間まで走査時刻を進める。
    // 一度に長い期間を読もうとして時間切れになると永久に進まなくなるため、
    // 1日分が時間内に読める限り必ず前進するようにする。
    const chunkMs = DISCOVERY_CHUNK_MS
    const budgetMs = options.discoveryTimeBudgetMs ?? DEFAULT_DISCOVERY_TIME_BUDGET_MS
    const startedMs = Date.now()
    let discovered = 0
    let truncated = false
    let cursor = from

    // 本番で確認した不具合(2026-09-27): 走査位置が無いセラー(追加したばかりの
    // akebono-32)は古い日付から順に読むため、直近にアップロードしたUK出品へ
    // たどり着く前に時間切れになり、いつまでも取り込めなかった。
    // 初回は「新しい区間から」読み、当日分を最優先で取り込む。
    if (!scannedUntil && sellerAccountId) {
      const siteIds = options.sellerSiteIds && options.sellerSiteIds.length > 0 ? options.sellerSiteIds : ['US']
      let chunkEnd = scanStartedAt
      let newestDone = false
      while (chunkEnd.getTime() > from.getTime()) {
        const chunkStart = new Date(Math.max(from.getTime(), chunkEnd.getTime() - chunkMs))
        let stop = false
        for (const siteId of siteIds) {
          const remaining = budgetMs - (Date.now() - startedMs)
          if (remaining <= 1_000) { truncated = true; stop = true; break }
          const scan = await scanSellerListByStartTime(
            { accessToken },
            { from: chunkStart, to: chunkEnd },
            { timeBudgetMs: remaining, signal: options.signal, siteId },
          )
          const active = scan.items.filter(item => !item.listingStatus || item.listingStatus === 'Active')
          const stored = await storeInventoryListings(db, userId, active, options)
          discovered += stored.matched
          if (scan.truncated) { truncated = true; stop = true; break }
        }
        if (!stop && !newestDone) {
          // 直近の区間を読み切れたら、次回はその時点以降だけを見ればよい
          newestDone = true
          const { error } = await db
            .from('seller_accounts')
            .update({ inventory_discovery_scanned_until: scanStartedAt.toISOString() })
            .eq('id', sellerAccountId)
            .eq('user_id', userId)
          if (error) console.warn('[inventory-sync] failed to record discovery time:', error.message)
        }
        if (stop) break
        chunkEnd = chunkStart
      }
      return { discovered, truncated }
    }
    while (cursor.getTime() < scanStartedAt.getTime()) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + chunkMs, scanStartedAt.getTime()))
      const remaining = budgetMs - (Date.now() - startedMs)
      if (remaining <= 1_000) { truncated = true; break }
      // 出品したサイトのSiteIDで呼ばないと、そのサイトの出品が返らない
      const siteIds = options.sellerSiteIds && options.sellerSiteIds.length > 0
        ? options.sellerSiteIds
        : ['US']
      let scanTruncated = false
      for (const siteId of siteIds) {
        const siteRemaining = budgetMs - (Date.now() - startedMs)
        if (siteRemaining <= 1_000) { scanTruncated = true; break }
        const scan = await scanSellerListByStartTime(
          { accessToken },
          { from: cursor, to: chunkEnd },
          { timeBudgetMs: siteRemaining, signal: options.signal, siteId },
        )
        // 終了済み(ユーザーが取り下げた等)の出品は在庫管理に入れない
        const active = scan.items.filter(item => !item.listingStatus || item.listingStatus === 'Active')
        const stored = await storeInventoryListings(db, userId, active, options)
        discovered += stored.matched
        if (scan.truncated) {
          scanTruncated = true
          console.warn(`[inventory-sync] discovery truncated (${siteId}): ${scan.pagesFetched}/${scan.totalPages} pages in ${cursor.toISOString()}..${chunkEnd.toISOString()}`)
          break
        }
      }
      if (scanTruncated) {
        truncated = true
        break
      }
      cursor = chunkEnd
      const { error } = sellerAccountId
        ? await db
          .from('seller_accounts')
          .update({ inventory_discovery_scanned_until: chunkEnd.toISOString() })
          .eq('id', sellerAccountId)
          .eq('user_id', userId)
        : await db
          .from('inventory_settings')
          .update({ discovery_scanned_until: chunkEnd.toISOString() })
          .eq('user_id', userId)
      if (error) console.warn('[inventory-sync] failed to record discovery time:', error.message)
    }
    return { discovered, truncated }
  } catch (error) {
    if (options.signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[inventory-sync] discovery of new listings failed:', message)
    return { discovered: 0, truncated: true, error: message }
  }
}

async function removeEndedListings(
  db: SupabaseClient,
  userId: string,
  itemIds: string[],
  sellerAccountId?: string | null,
): Promise<void> {
  if (itemIds.length === 0) return
  for (let index = 0; index < itemIds.length; index += DB_CHUNK_SIZE) {
    const chunk = itemIds.slice(index, index + DB_CHUNK_SIZE)
    await markProductsForEndedListings(db, userId, chunk)
    let query = db
      .from('inventory_active_listings')
      .delete()
      .eq('user_id', userId)
      .in('ebay_item_id', chunk)
    if (sellerAccountId) query = query.eq('seller_account_id', sellerAccountId)
    const { error } = await query
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

  // 実データで確認した不具合: 1回の手動同期(最初のバッチだけ15秒)では
  // 走査が数日分しか進まず、CSVで出品した29件が下書きのまま残った。
  // 各バッチで走査を続け、1回の同期で走査に使える時間を増やす。
  const discovery = await discoverNewListings(db, userId, accessToken, options)

  const knownIds = await collectKnownItemIds(db, userId, options)
  const totalBatches = Math.max(1, Math.ceil(knownIds.length / batchSize))
  const start = (batchIndex - 1) * batchSize

  let fetched: Awaited<ReturnType<typeof fetchListingsByItemIds>> = { items: [], endedItemIds: [] }
  let callLimited = false

  // GetMyeBaySelling(1回200件)でまとめて取得できた場合は、1リクエストで
  // このセラーの全件を更新する(695件で約30回。GetItemなら695回かかる)。
  let bulkError: string | undefined
  const fetchStartedAt = Date.now()
  let bulk: { map: Map<string, InventoryListingInput>; complete: boolean } | null = null
  // knownIdsが0件でも実行する。出品一覧(GetMyeBaySelling)にはSKU付きで
  // 全出品が返るため、新しいセラーの出品の発見にもそのまま使える。
  if (options.bulkRefresh === true && batchIndex === 1) {
    try {
      bulk = await fetchActiveListingMap(accessToken, options.sellerSiteIds ?? [], options)
    } catch (error) {
      if (error instanceof EbayCallLimitError) callLimited = true
      bulkError = error instanceof Error ? error.message : String(error)
      console.warn('[inventory-sync] bulk refresh failed, falling back to GetItem:', bulkError)
      bulk = null
    }
  }
  // 本番で確認した不具合(2026-09-28): 一括取得が時間切れした後に個別照会を
  // 重ねてルートの打ち切り(45秒)を超えていた。eBayへの取得に使ってよい残り
  // 時間を計算し、足りなければ個別照会は次回に回す。
  const fetchBudgetMs = options.fetchTotalTimeoutMs
  const remainingFetchMs = fetchBudgetMs ? fetchBudgetMs - (Date.now() - fetchStartedAt) : undefined
  const canFetchItems = remainingFetchMs === undefined || remainingFetchMs > 5_000

  const targetIds = bulk ? knownIds : knownIds.slice(start, start + batchSize)

  if (bulk) {
    // 本番で確認した不具合(2026-09-28): 新しいセラー(akebono-32)は
    // GetSellerListの走査が毎回時間切れになり、UKに出品した127件をいつまでも
    // 発見できなかった。出品一覧に載っている出品は、在庫一覧に未登録でも
    // そのまま取り込む(Kakehashiの商品に紐付くものだけが保存される)。
    const known = new Set(targetIds)
    const found: InventoryListingInput[] = []
    const missing: string[] = []
    for (const id of targetIds) {
      const item = bulk.map.get(id)
      if (item) found.push(item)
      else missing.push(id)
    }
    // 本番で確認した不具合(2026-09-28): 出品一覧の全件(他ツールの出品を含めて
    // 約5,400件)を保存処理に回したため、商品照会が膨大になり45秒で打ち切られた。
    // 在庫一覧に未登録の分は、Kakehashiのラベルが付いた出品だけに絞る。
    for (const [itemId, item] of bulk.map) {
      if (known.has(itemId)) continue
      if (!hasKakehashiLabel(item.customLabel)) continue
      found.push(item)
    }
    const missingLimit = options.maxMissingChecksPerRun ?? DEFAULT_MISSING_CHECKS_PER_RUN
    const toCheck = canFetchItems ? missing.slice(0, Math.max(0, missingLimit)) : []
    let checked: Awaited<ReturnType<typeof fetchListingsByItemIds>> = { items: [], endedItemIds: [] }
    if (toCheck.length > 0) {
      try {
        checked = await fetchListingsByItemIds(
          { accessToken },
          toCheck,
          { signal: options.signal, totalTimeoutMs: remainingFetchMs },
        )
      } catch (error) {
        if (!(error instanceof EbayCallLimitError)) throw error
        callLimited = true
      }
    }
    fetched = { items: [...found, ...checked.items], endedItemIds: checked.endedItemIds }
  } else if (!callLimited && canFetchItems) {
    try {
      fetched = await fetchListingsByItemIds(
        { accessToken },
        targetIds,
        { signal: options.signal, totalTimeoutMs: options.fetchTotalTimeoutMs },
      )
    } catch (error) {
      if (!(error instanceof EbayCallLimitError)) throw error
      // 呼び出し上限。新規出品の発見結果は残し、既存出品の更新だけ見送る
      callLimited = true
    }
  }
  const stored = await storeInventoryListings(db, userId, fetched.items, options)
  await removeEndedListings(db, userId, fetched.endedItemIds, options.sellerAccountId)
  if (!callLimited) await purgeUnmanagedListings(db, userId, options.sellerAccountId)

  const processedItems = bulk ? knownIds.length : Math.min(knownIds.length, start + targetIds.length)
  return {
    totalItems: knownIds.length,
    processedItems,
    updated: stored.matched,
    ended: fetched.endedItemIds.length,
    discovered: discovery.discovered,
    discoveryTruncated: discovery.truncated,
    discoveryError: discovery.error,
    callLimited,
    bulkItems: bulk?.map.size,
    bulkComplete: bulk?.complete,
    bulkError,
    // 一括更新できたときはこのセラーの分は1回で終わり。
    // 上限中も同じセラーを繰り返し照会しても意味がないので次へ進める。
    nextBatch: !bulk && !callLimited && batchIndex < totalBatches ? batchIndex + 1 : null,
    totalBatches: bulk ? 1 : totalBatches,
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
  const discovery = await discoverNewListings(db, userId, accessToken, options)
  const knownIds = await collectKnownItemIds(db, userId, options)

  // 前回の続きから照会する(ItemIDはソート済み。見つからなければ先頭から)
  const startIndex = options.cursorItemId
    ? Math.max(0, knownIds.indexOf(options.cursorItemId) + 1)
    : 0
  const maxItems = options.maxItemsPerRun && options.maxItemsPerRun > 0 ? options.maxItemsPerRun : knownIds.length
  const targetIds = knownIds.slice(startIndex, startIndex + maxItems)
  const finishedAll = startIndex + targetIds.length >= knownIds.length
  const nextCursorItemId = finishedAll ? null : targetIds[targetIds.length - 1] ?? null

  // まず GetMyeBaySelling でまとめて取得する(1回200件)。失敗したら従来どおり
  // GetItemで1件ずつ照会する。
  let bulk: { map: Map<string, InventoryListingInput>; complete: boolean } | null = null
  let callLimited = false
  let bulkError: string | undefined
  const fetchStartedAt = Date.now()
  if (options.bulkRefresh === true) {
    try {
      bulk = await fetchActiveListingMap(accessToken, options.sellerSiteIds ?? [], options)
    } catch (error) {
      if (error instanceof EbayCallLimitError) callLimited = true
      bulkError = error instanceof Error ? error.message : String(error)
      console.warn('[inventory-sync] bulk refresh failed, falling back to GetItem:', bulkError)
      bulk = null
    }
  }
  // 本番で確認した不具合(2026-09-28): 一括取得が時間切れした後に個別照会を
  // 重ねてルートの打ち切り(45秒)を超えていた。eBayへの取得に使ってよい残り
  // 時間を計算し、足りなければ個別照会は次回に回す。
  const fetchBudgetMs = options.fetchTotalTimeoutMs
  const remainingFetchMs = fetchBudgetMs ? fetchBudgetMs - (Date.now() - fetchStartedAt) : undefined
  const canFetchItems = remainingFetchMs === undefined || remainingFetchMs > 5_000

  let fetched: Awaited<ReturnType<typeof fetchListingsByItemIds>> = { items: [], endedItemIds: [] }
  if (bulk) {
    // 本番で確認した不具合(2026-09-28): 新しいセラー(akebono-32)は
    // GetSellerListの走査が毎回時間切れになり、UKに出品した127件をいつまでも
    // 発見できなかった。出品一覧に載っている出品は、在庫一覧に未登録でも
    // そのまま取り込む(Kakehashiの商品に紐付くものだけが保存される)。
    const known = new Set(targetIds)
    const found: InventoryListingInput[] = []
    const missing: string[] = []
    for (const id of targetIds) {
      const item = bulk.map.get(id)
      if (item) found.push(item)
      else missing.push(id)
    }
    // 本番で確認した不具合(2026-09-28): 出品一覧の全件(他ツールの出品を含めて
    // 約5,400件)を保存処理に回したため、商品照会が膨大になり45秒で打ち切られた。
    // 在庫一覧に未登録の分は、Kakehashiのラベルが付いた出品だけに絞る。
    for (const [itemId, item] of bulk.map) {
      if (known.has(itemId)) continue
      if (!hasKakehashiLabel(item.customLabel)) continue
      found.push(item)
    }
    // 一覧に無かった出品は売却・終了の可能性。誤って消さないよう個別に確認する
    // (件数は多くないのが通常。多い場合は上限までにして残りは次回へ)
    const missingLimit = options.maxMissingChecksPerRun ?? DEFAULT_MISSING_CHECKS_PER_RUN
    const toCheck = canFetchItems ? missing.slice(0, Math.max(0, missingLimit)) : []
    let checked: Awaited<ReturnType<typeof fetchListingsByItemIds>> = { items: [], endedItemIds: [] }
    if (toCheck.length > 0) {
      try {
        checked = await fetchListingsByItemIds(
          { accessToken },
          toCheck,
          { signal: options.signal, totalTimeoutMs: remainingFetchMs, concurrency: options.getItemConcurrency },
        )
      } catch (error) {
        if (!(error instanceof EbayCallLimitError)) throw error
        callLimited = true
      }
    }
    fetched = { items: [...found, ...checked.items], endedItemIds: checked.endedItemIds }
  } else if (!callLimited && canFetchItems) {
    try {
      fetched = await fetchListingsByItemIds(
        { accessToken },
        targetIds,
        { signal: options.signal, totalTimeoutMs: options.fetchTotalTimeoutMs, concurrency: options.getItemConcurrency },
      )
    } catch (error) {
      if (!(error instanceof EbayCallLimitError)) throw error
      callLimited = true
    }
  }
  const stored = await storeInventoryListings(db, userId, fetched.items, options)
  await removeEndedListings(db, userId, fetched.endedItemIds, options.sellerAccountId)
  // 途中までしか照会していない回では、紐付かない出品の掃除は行わない
  // (未照会の出品を誤って消さないため)
  if (finishedAll && !callLimited) await purgeUnmanagedListings(db, userId, options.sellerAccountId)

  return {
    total: knownIds.length,
    matched: stored.matched,
    ended: fetched.endedItemIds.length,
    discovered: discovery.discovered,
    discoveryTruncated: discovery.truncated,
    discoveryError: discovery.error,
    callLimited,
    bulkItems: bulk?.map.size,
    bulkComplete: bulk?.complete,
    bulkError,
    processed: callLimited ? 0 : targetIds.length,
    nextCursorItemId,
  }
}
