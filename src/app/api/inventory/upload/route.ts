// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { parseEbayActiveListingsCsv, extractSourceLookupCode } from '@/lib/inventory'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

const MAX_CSV_BYTES = 5 * 1024 * 1024 // 5 MB

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contentLength = req.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_CSV_BYTES) {
    return NextResponse.json({ error: 'ファイルサイズが5MBを超えています' }, { status: 413 })
  }

  let csvText: string
  try {
    const formData = await req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'fileフィールドが必要です' }, { status: 400 })
    }
    const buf = await (file as File).arrayBuffer()
    if (buf.byteLength > MAX_CSV_BYTES) {
      return NextResponse.json({ error: 'ファイルサイズが5MBを超えています' }, { status: 413 })
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

  const productLookup = new Map<string, string>()
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
    const productId = code ? (productLookup.get(code) ?? null) : null
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
