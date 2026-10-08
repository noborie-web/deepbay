// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import {
  extractProductIdFromCustomLabel,
  extractSourceLookupKeys,
  parseEbayActiveListingsCsv,
  resolveInventoryProductId,
} from '@/lib/inventory'
import { applyListingStateToProducts } from '@/lib/inventory-sync'
import { EBAY_SITES, isEbaySiteKey } from '@/lib/ebay-sites'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// eBayのAll active listingsレポートは件数が多いと数十MBになるため、
// 余裕を持って50MBまで受け付ける。
const MAX_CSV_BYTES = 50 * 1024 * 1024 // 50 MB

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ユーザー要望(2026-09-29): 出品アカウントを複数運用しているため、CSV取込も
  // 「どのセラーの、どのサイトの出品か」を指定できるようにする。指定しないと
  // 他セラーの在庫まで置き換えてしまう(本番でその手前まで来ていた)。
  const sellerAccountId = req.nextUrl.searchParams.get('sellerAccountId')?.trim() || null
  const siteParam = (req.nextUrl.searchParams.get('siteId')?.trim() || 'US').toUpperCase()
  const siteKey = isEbaySiteKey(siteParam) ? siteParam : 'US'
  const site = EBAY_SITES[siteKey]

  const contentType = req.headers.get('content-type') ?? ''
  let csvText = ''
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => null) as { path?: string } | null
    if (!body?.path || !body.path.startsWith(`${user.id}/`)) return NextResponse.json({ error: 'アップロードファイルが不正です' }, { status: 400 })
    const storage = admin().storage.from('inventory-uploads')
    const { data: downloaded, error } = await storage.download(body.path)
    if (error || !downloaded) return NextResponse.json({ error: error?.message ?? 'ファイルを取得できません' }, { status: 400 })
    const buf = await downloaded.arrayBuffer()
    if (buf.byteLength > MAX_CSV_BYTES) return NextResponse.json({ error: 'ファイルサイズが50MBを超えています' }, { status: 413 })
    csvText = new TextDecoder('utf-8').decode(buf)
  }
  const contentLength = req.headers.get('content-length')
  if (contentType.includes('application/json')) {
    if (!csvText) return NextResponse.json({ error: 'ファイルを読み込めません' }, { status: 400 })
  } else if (contentLength && parseInt(contentLength, 10) > MAX_CSV_BYTES) {
    return NextResponse.json({ error: 'ファイルサイズが50MBを超えています' }, { status: 413 })
  }

  if (!contentType.includes('application/json')) try {
    const formData = await req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'fileフィールドが必要です' }, { status: 400 })
    }
    const buf = await (file as File).arrayBuffer()
    if (buf.byteLength > MAX_CSV_BYTES) {
      return NextResponse.json({ error: 'ファイルサイズが50MBを超えています' }, { status: 413 })
    }
    csvText = new TextDecoder('utf-8').decode(buf)
  } catch {
    return NextResponse.json({ error: 'ファイルの読み込みに失敗しました' }, { status: 400 })
  }

  const listings = parseEbayActiveListingsCsv(csvText)
  if (listings.length === 0) {
    return NextResponse.json({ error: 'CSVから商品を取得できませんでした' }, { status: 422 })
  }

  const db = admin()
  const now = new Date().toISOString()

  if (sellerAccountId) {
    const { data: seller } = await db
      .from('seller_accounts')
      .select('id')
      .eq('id', sellerAccountId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!seller) return NextResponse.json({ error: '出品アカウントが見つかりません' }, { status: 404 })
  }

  // An active report is a complete snapshot. Remove the previous snapshot
  // before inserting this upload so the displayed count is the latest count,
  // rather than the cumulative total of all uploads.
  // セラー(とサイト)を指定した場合は、その範囲だけを置き換える。
  let clearQuery = db
    .from('inventory_active_listings')
    .delete()
    .eq('user_id', user.id)
  if (sellerAccountId) {
    clearQuery = clearQuery.eq('seller_account_id', sellerAccountId).eq('site_id', site.siteId)
  }
  const { error: clearError } = await clearQuery
  if (clearError) return NextResponse.json({ error: `既存の在庫スナップショットを更新できません: ${clearError.message}` }, { status: 500 })

  // Create audit run
  const { data: run, error: runError } = await db
    .from('inventory_runs')
    .insert({ user_id: user.id, run_type: 'upload', status: 'running' })
    .select('id')
    .single()

  if (runError || !run) return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
  const runId = run.id

  // Resolve exact custom-label keys to product IDs.
  const sourceLookupKeys = Array.from(new Set(
    listings.flatMap((listing) => extractSourceLookupKeys(listing.customLabel)),
  ))
  const productIds = Array.from(new Set(
    listings
      .map((listing) => extractProductIdFromCustomLabel(listing.customLabel))
      .filter((id): id is string => id !== null),
  ))
  const ebayItemIds = Array.from(new Set(listings.map((l) => l.ebayItemId).filter(Boolean)))

  const productLookup = new Map<string, string>()
  if (productIds.length > 0) {
    const { data: directProducts } = await db
      .from('products')
      .select('id, ebay_item_id')
      .eq('user_id', user.id)
      .in('id', productIds)
    for (const p of directProducts ?? []) productLookup.set(p.id, p.id)
  }
  if (ebayItemIds.length > 0) {
    const { data: ebayProducts } = await db
      .from('products')
      .select('id, ebay_item_id')
      .eq('user_id', user.id)
      .in('ebay_item_id', ebayItemIds)
    for (const p of ebayProducts ?? []) {
      if (p.ebay_item_id) productLookup.set(`ebay:${p.ebay_item_id}`, p.id)
    }
  }
  const sourceProductLookup = new Map<string, Set<string>>()
  if (sourceLookupKeys.length > 0) {
    const { data: matchedProducts } = await db
      .from('products')
      .select('id, source_item_id')
      .eq('user_id', user.id)
      .in('source_item_id', sourceLookupKeys)

    for (const p of matchedProducts ?? []) {
      if (!p.source_item_id) continue
      const productIdsForSource = sourceProductLookup.get(p.source_item_id) ?? new Set<string>()
      productIdsForSource.add(p.id)
      sourceProductLookup.set(p.source_item_id, productIdsForSource)
    }
  }

  // ユーザー要望: 他ツールで在庫管理中の出品を混在させないため、
  // Kakehashiの商品に紐付く出品だけを保存する(API同期と同じ方針)。
  // ユーザー報告(2026-10-08): 商品レコードが失われたKakehashi出品
  // (CustomLabelは kakehashi_<UUID>)も、ここで捨てられていた。捨てると
  // 在庫管理に載らず、存在にも気づけない。API同期側(#265)と同じく、
  // Kakehashiが発行したラベルがある出品は商品が無くても保存する。
  const rows = listings.flatMap((l) => {
    const directProductId = extractProductIdFromCustomLabel(l.customLabel)
    const sourceProductIds = extractSourceLookupKeys(l.customLabel)
      .flatMap(key => Array.from(sourceProductLookup.get(key) ?? []))
    const productId = resolveInventoryProductId(
      directProductId ? productLookup.get(directProductId) : null,
      productLookup.get(`ebay:${l.ebayItemId}`),
      sourceProductIds,
    )
    // directProductId は kakehashi_<UUID> / deepbay_<UUID> 形式のときだけ
    // 値が入る(他ツールの任意のSKUでは null)。商品が見つからなくても、
    // Kakehashiが出品した印があるなら保存する。
    if (!productId && directProductId === null) return []

    return [{
      ...(sellerAccountId ? { seller_account_id: sellerAccountId, site_id: site.siteId, currency: site.currency } : {}),
      user_id: user.id,
      ebay_item_id: l.ebayItemId,
      custom_label: l.customLabel,
      title: l.title,
      current_price: l.currentPrice,
      quantity: l.quantity,
      quantity_sold: l.quantitySold,
      listing_status: l.listingStatus,
      start_time: l.startTime,
      end_time: l.endTime,
      product_id: productId,
      fetched_at: now,
      updated_at: now,
    }]
  })
  const matched = rows.filter((row) => row.product_id !== null).length
  // 商品レコードが失われているKakehashi出品(仕入先URLが無く在庫チェック不可)
  const unmanaged = rows.length - matched

  const CHUNK = 100
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: upsertErr } = await db
      .from('inventory_active_listings')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'user_id,ebay_item_id' })
    if (upsertErr) {
      await db.from('inventory_runs').update({
        status: 'failed', error_message: upsertErr.message, finished_at: now,
        items_total: listings.length, items_matched: matched,
      }).eq('id', runId)
      return NextResponse.json({ error: upsertErr.message }, { status: 500 })
    }
  }

  // 商品レコードが無い出品は、反映先の商品が存在しないので対象外
  await applyListingStateToProducts(db, user.id, rows
    .filter((row): row is typeof row & { product_id: string } => row.product_id !== null)
    .map(row => ({
      product_id: row.product_id,
      ebay_item_id: row.ebay_item_id,
      quantity: row.quantity,
      quantity_sold: row.quantity_sold,
    })))

  await db.from('inventory_runs').update({
    status: 'completed',
    items_total: listings.length,
    items_matched: matched,
    result_summary: { unmanaged },
    finished_at: now,
  }).eq('id', runId)

  return NextResponse.json({ ok: true, total: listings.length, matched, unmanaged })
}
