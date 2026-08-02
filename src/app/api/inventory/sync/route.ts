// 現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { fetchAllActiveListings, refreshEbayToken } from '@/lib/ebay-inventory'
import { extractSourceLookupCode } from '@/lib/inventory'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()

  const { data: settings, error: settingsError } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  if (settingsError) return NextResponse.json({ error: settingsError.message }, { status: 500 })
  if (!settings?.ebay_token) {
    return NextResponse.json({ error: 'eBayトークンが設定されていません' }, { status: 400 })
  }

  const { data: run, error: runError } = await db
    .from('inventory_runs')
    .insert({ user_id: user.id, run_type: 'sync', status: 'running' })
    .select('id')
    .single()

  if (runError || !run) return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
  const runId = run.id
  const now = new Date().toISOString()

  let accessToken = settings.ebay_token

  if (settings.ebay_refresh_token && settings.ebay_token_expires_at) {
    const expiresAt = new Date(settings.ebay_token_expires_at)
    if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
      try {
        const refreshed = await refreshEbayToken(settings.ebay_refresh_token)
        accessToken = refreshed.accessToken
        await db.from('inventory_settings').update({
          ebay_token: refreshed.accessToken,
          ebay_token_expires_at: refreshed.expiresAt.toISOString(),
          updated_at: now,
        }).eq('user_id', user.id)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await db.from('inventory_runs').update({
          status: 'failed', error_message: msg, finished_at: now,
        }).eq('id', runId)
        return NextResponse.json({ error: `トークン更新失敗: ${msg}` }, { status: 500 })
      }
    }
  }

  let listings
  try {
    listings = await fetchAllActiveListings({ accessToken })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.from('inventory_runs').update({
      status: 'failed', error_message: msg, finished_at: now,
    }).eq('id', runId)
    return NextResponse.json({ error: `eBay取得失敗: ${msg}` }, { status: 500 })
  }

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
