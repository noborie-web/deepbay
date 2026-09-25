import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'
import { fetchActiveListingsBatch } from '@/lib/ebay-inventory'
import { conditionFromEbayId, extractDescriptionBody, fetchEbayItemDetails } from '@/lib/ebay-item-details'
import { extractProductIdFromCustomLabel } from '@/lib/inventory'
import { storeInventoryListings } from '@/lib/inventory-sync'

// ユーザー要望(事故復旧): 抽出の削除で消えた出品済み商品を、eBay上の出品
// (Kakehashi SKU = kakehashi_{商品ID})からKakehashiに復元する。
//  mode=status  : 復元候補(Kakehashi SKUだが商品が存在しない出品)の件数
//  mode=recover : 候補を limit 件ずつ GetItem で取得し、同じ商品IDで商品を
//                 再作成して在庫管理に紐付ける
// 候補は、eBayの新しい順 DISCOVER_PAGES ページ分の走査と、body.item_ids で
// 指定されたItemIDの両方から集める。
export const maxDuration = 300

const RECOVER_LIMIT_MAX = 20
const DISCOVER_PAGES = 3

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface Candidate { itemId: string; productId: string; sku: string }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { mode?: string; limit?: number; item_ids?: unknown }
  const mode = body.mode ?? 'status'
  const requestedItemIds = Array.isArray(body.item_ids)
    ? Array.from(new Set(body.item_ids.map(v => String(v).trim()).filter(v => /^\d{9,15}$/.test(v))))
    : []
  const db = admin()

  const { data: settings } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()
  let accessToken: string
  try {
    // 複数セラー運用では、代表(最初に接続した)セラーのトークンで照会する
    accessToken = (await createInventoryTokenResolver(db, user.id, settings ?? {})).defaultToken!
  } catch (error) {
    return NextResponse.json({ error: `eBayトークンの取得に失敗しました: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 })
  }

  // 候補の収集: 新しい順の出品から Kakehashi SKU を拾う + 指定ItemID
  const candidates = new Map<string, Candidate>()
  const skuByItemId = new Map<string, string>()
  try {
    const batch = await fetchActiveListingsBatch({ accessToken }, 1, DISCOVER_PAGES, { totalTimeoutMs: 90_000 })
    for (const item of batch.items) {
      const productId = extractProductIdFromCustomLabel(item.customLabel)
      if (productId && item.customLabel) {
        skuByItemId.set(item.ebayItemId, item.customLabel)
        candidates.set(item.ebayItemId, { itemId: item.ebayItemId, productId, sku: item.customLabel })
      }
    }
  } catch (error) {
    console.warn('recover-products: discovery failed', error)
  }
  for (const itemId of requestedItemIds) {
    if (!candidates.has(itemId)) candidates.set(itemId, { itemId, productId: '', sku: '' })
  }

  // すでに商品が存在するものは除く
  const knownProductIds = Array.from(candidates.values()).map(c => c.productId).filter(Boolean)
  const existing = new Set<string>()
  for (let i = 0; i < knownProductIds.length; i += 200) {
    const { data } = await db.from('products').select('id').eq('user_id', user.id).in('id', knownProductIds.slice(i, i + 200))
    for (const row of data ?? []) existing.add(row.id as string)
  }
  const allItemIds = Array.from(candidates.keys())
  const existingItemIds = new Set<string>()
  for (let i = 0; i < allItemIds.length; i += 200) {
    const { data } = await db.from('products').select('ebay_item_id').eq('user_id', user.id).in('ebay_item_id', allItemIds.slice(i, i + 200))
    for (const row of data ?? []) if (row.ebay_item_id) existingItemIds.add(row.ebay_item_id as string)
  }
  const pending = Array.from(candidates.values()).filter(c => !(c.productId && existing.has(c.productId)) && !existingItemIds.has(c.itemId))

  if (mode === 'status') {
    return NextResponse.json({ ok: true, candidates: pending.length, discovered: candidates.size })
  }
  if (mode !== 'recover') return NextResponse.json({ error: `不明な mode: ${mode}` }, { status: 400 })

  const limit = Math.min(Math.max(1, Math.floor(body.limit ?? RECOVER_LIMIT_MAX)), RECOVER_LIMIT_MAX)
  const targets = pending.slice(0, limit)
  const recovered: Array<{ product_id: string; ebay_item_id: string; title: string }> = []
  // 商品は存在していて出品情報の紐付けだけを行ったもの(下書き→出品中)
  const linked: Array<{ product_id: string; ebay_item_id: string; title: string }> = []
  const failed: Array<{ ebay_item_id: string; error: string }> = []
  const listingInputs = []

  for (const candidate of targets) {
    try {
      const details = await fetchEbayItemDetails(accessToken, candidate.itemId)
      if (details === 'not_found') throw new Error('eBayに存在しない出品です')
      const sku = details.sku ?? skuByItemId.get(candidate.itemId) ?? candidate.sku
      const productId = extractProductIdFromCustomLabel(sku)
      if (!productId) throw new Error(`Kakehashiの管理番号(SKU)ではありません: ${sku || '(なし)'}`)
      // 実データで確認した不具合: CSVでeBayに出品した下書き商品のItemIDを貼り付けても、
      // 商品が既に存在する場合は「復元済み」扱いで在庫管理に紐付けず、下書きのまま
      // 残っていた。既存商品は再作成せず、出品情報だけを紐付ける(listing_status /
      // ebay_item_id は storeInventoryListings が更新する)。
      const { data: already } = await db.from('products').select('id').eq('id', productId).maybeSingle()
      if (already) {
        linked.push({ product_id: productId, ebay_item_id: candidate.itemId, title: details.title })
        listingInputs.push({
          ebayItemId: candidate.itemId,
          customLabel: sku,
          title: details.title,
          imageUrl: details.pictureUrls[0] ?? null,
          currentPrice: details.currentPrice,
          quantity: details.quantity,
          quantitySold: details.quantitySold,
          listingStatus: details.listingStatus,
          startTime: details.startTime,
          endTime: null,
        })
        continue
      }

      const now = new Date().toISOString()
      const status = details.listingStatus !== 'Active'
        ? 'delisted'
        : (details.quantity ?? 0) > 0 ? 'listed' : (details.quantitySold > 0 ? 'sold' : 'delisted')
      const condition = conditionFromEbayId(details.conditionId)
      const { error } = await db.from('products').insert({
        id: productId,
        user_id: user.id,
        extraction_id: null,
        // 本番で確認した不具合: source_url は NOT NULL のため null では作成できず
        // 全件失敗した。仕入先URLが判明するまでの仮の値として eBay の商品URLを
        // 入れる(対応スクレイパーが無いため仕入先チェックは skipped になる)。
        source_url: `https://www.ebay.com/itm/${candidate.itemId}`,
        source_site: 'ebay',
        source_item_id: null,
        original_title: details.title,
        original_price: null,
        original_description: null,
        original_images: details.pictureUrls,
        original_condition: condition,
        ebay_title: details.title,
        ebay_brand: null,
        ebay_price: details.currentPrice,
        ebay_description: extractDescriptionBody(details.descriptionHtml),
        ebay_images: details.pictureUrls,
        ebay_item_specifics: {},
        ebay_condition: condition,
        ebay_category_id: details.categoryId,
        listing_status: status,
        ebay_item_id: candidate.itemId,
        listed_at: details.startTime ?? now,
        description_synced_at: now,
        price_type: 'fixed',
        created_at: now,
        updated_at: now,
      })
      if (error) throw new Error(error.message)
      recovered.push({ product_id: productId, ebay_item_id: candidate.itemId, title: details.title })
      listingInputs.push({
        ebayItemId: candidate.itemId,
        customLabel: sku,
        title: details.title,
        imageUrl: details.pictureUrls[0] ?? null,
        currentPrice: details.currentPrice,
        quantity: details.quantity,
        quantitySold: details.quantitySold,
        listingStatus: details.listingStatus,
        startTime: details.startTime,
        endTime: null,
      })
    } catch (error) {
      failed.push({ ebay_item_id: candidate.itemId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // 在庫管理に紐付ける(商品が存在するようになったので product_id が解決される)
  if (listingInputs.length > 0) {
    try { await storeInventoryListings(db, user.id, listingInputs) } catch (error) { console.warn('recover-products: inventory link failed', error) }
  }

  const remaining = Math.max(0, pending.length - recovered.length - linked.length - failed.length)
  return NextResponse.json({ ok: true, recovered: recovered.length, linked: linked.length, failed, remaining, done: remaining <= 0, items: [...recovered, ...linked] })
}
