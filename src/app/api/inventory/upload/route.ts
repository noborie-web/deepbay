// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { parseEbayActiveListingsCsv, extractProductIdFromCustomLabel, extractSourceLookupCode } from '@/lib/inventory'

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

  // An active report is a complete snapshot. Remove the previous snapshot
  // before inserting this upload so the displayed count is the latest count,
  // rather than the cumulative total of all uploads.
  const { error: clearError } = await db
    .from('inventory_active_listings')
    .delete()
    .eq('user_id', user.id)
  if (clearError) return NextResponse.json({ error: `既存の在庫スナップショットを更新できません: ${clearError.message}` }, { status: 500 })

  // Create audit run
  const { data: run, error: runError } = await db
    .from('inventory_runs')
    .insert({ user_id: user.id, run_type: 'upload', status: 'running' })
    .select('id')
    .single()

  if (runError || !run) return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
  const runId = run.id

  // Resolve management codes to product IDs
  const managementCodes = listings
    .map((l) => extractSourceLookupCode(l.customLabel))
    .filter((c): c is string => c !== null)
  const productIds = listings
    .map((l) => extractProductIdFromCustomLabel(l.customLabel))
    .filter((id): id is string => id !== null)
  const ebayItemIds = Array.from(new Set(listings.map((l) => l.ebayItemId).filter(Boolean)))

  const productLookup = new Map<string, string>()
  if (productIds.length > 0) {
    const { data: directProducts } = await db
      .from('products')
      .select('id, ebay_item_id')
      .eq('user_id', user.id)
      .in('id', Array.from(new Set(productIds)))
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
  if (managementCodes.length > 0) {
    const { data: matchedProducts } = await db
      .from('products')
      .select('id, source_item_id')
      .eq('user_id', user.id)
      .in('source_item_id', managementCodes)

    for (const p of matchedProducts ?? []) {
      if (p.source_item_id) productLookup.set(p.source_item_id, p.id)
    }
  }

  let matched = 0
  const rows = listings.map((l) => {
    const code = extractSourceLookupCode(l.customLabel)
    const directProductId = extractProductIdFromCustomLabel(l.customLabel)
    const productId = directProductId
      ? (productLookup.get(directProductId) ?? null)
      : code
        ? (productLookup.get(code) ?? productLookup.get(`ebay:${l.ebayItemId}`) ?? null)
        : productLookup.get(`ebay:${l.ebayItemId}`) ?? null
    if (productId) matched++

    return {
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
    }
  })

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

  await db.from('inventory_runs').update({
    status: 'completed',
    items_total: listings.length,
    items_matched: matched,
    finished_at: now,
  }).eq('id', runId)

  return NextResponse.json({ ok: true, total: listings.length, matched })
}
