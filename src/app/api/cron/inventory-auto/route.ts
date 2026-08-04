// Vercel Cron Job — 自動実行エンドポイント（毎時0分に起動、schedule_timeと照合）
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { endItem, reviseQuantityToZero, revisePrice, addFixedPriceItem, resolveAccessToken } from '@/lib/ebay-actions'

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest) {
  // Vercel Cron認証
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = admin()
  const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const currentHour = nowJST.getUTCHours().toString().padStart(2, '0')
  const currentMin = nowJST.getUTCMinutes().toString().padStart(2, '0')
  const currentTime = `${currentHour}:${currentMin}`

  // schedule_timeが現在時刻に一致するユーザーのみ実行（±1分の許容）
  const { data: allSettings } = await db
    .from('inventory_settings')
    .select('user_id, ebay_token, ebay_refresh_token, ebay_token_expires_at, auto_delist, auto_revise_price, auto_stack, schedule_time, payment_profile_name, return_profile_name, shipping_profile_name')
    .eq('sync_enabled', true)

  const results: Record<string, unknown>[] = []

  for (const settings of allSettings ?? []) {
    if (!settings.schedule_time || !settings.ebay_token) continue

    // 時刻マッチング（HH:MM形式）
    const [sH, sM] = (settings.schedule_time as string).split(':').map(Number)
    const [cH, cM] = currentTime.split(':').map(Number)
    if (sH !== cH || Math.abs(sM - cM) > 1) continue

    const userId = settings.user_id
    const accessToken = await resolveAccessToken(settings as { ebay_token: string; ebay_refresh_token?: string | null; ebay_token_expires_at?: string | null })
    const userResult: Record<string, unknown> = { user_id: userId }

    // 取り下げ
    if (settings.auto_delist) {
      const { data: listings } = await db
        .from('inventory_active_listings')
        .select('ebay_item_id, product_id')
        .eq('user_id', userId)
        .eq('quantity', 0)

      const delistResults = []
      for (const l of listings ?? []) {
        const r = l.product_id
          ? await reviseQuantityToZero(accessToken, l.ebay_item_id)
          : await endItem(accessToken, l.ebay_item_id)
        delistResults.push(r)
      }
      userResult.delist = { total: delistResults.length, succeeded: delistResults.filter(r => r.success).length }

      await db.from('inventory_runs').insert({
        user_id: userId, run_type: 'auto_delist', status: 'completed',
        result_summary: userResult.delist,
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      })
    // ignore log errors
    }

    // 価格改定
    if (settings.auto_revise_price) {
      const { data: listings } = await db
        .from('inventory_active_listings')
        .select('ebay_item_id, current_price, product_id')
        .eq('user_id', userId)
        .not('product_id', 'is', null)

      const productIds = (listings ?? []).map(l => l.product_id as string)
      const productMap = new Map<string, { ebay_price: number | null }>()
      if (productIds.length > 0) {
        const { data: products } = await db.from('products').select('id, ebay_price').in('id', productIds)
        for (const p of products ?? []) productMap.set(p.id, p)
      }

      const reviseResults = []
      for (const l of listings ?? []) {
        const p = productMap.get(l.product_id!)
        if (!p?.ebay_price || !l.current_price || Math.abs(p.ebay_price - l.current_price) <= 0.5) continue
        const r = await revisePrice(accessToken, l.ebay_item_id, p.ebay_price)
        reviseResults.push(r)
      }
      userResult.revise_price = { total: reviseResults.length, succeeded: reviseResults.filter(r => r.success).length }

      await db.from('inventory_runs').insert({
        user_id: userId, run_type: 'auto_revise_price', status: 'completed',
        result_summary: userResult.revise_price,
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      })
    // ignore log errors
    }

    // 積み上げ
    if (settings.auto_stack && settings.payment_profile_name && settings.shipping_profile_name && settings.return_profile_name) {
      const { data: stackingItems } = await db
        .from('inventory_stacking')
        .select('ebay_item_id, new_source_url')
        .eq('user_id', userId)
        .eq('is_excluded', false)
        .not('new_source_url', 'is', null)

      const ebayItemIds = (stackingItems ?? []).map(s => s.ebay_item_id)
      const { data: listings } = await db
        .from('inventory_active_listings')
        .select('ebay_item_id, title, current_price, product_id')
        .eq('user_id', userId)
        .in('ebay_item_id', ebayItemIds)
        .eq('quantity', 0)

      const listingMap = new Map((listings ?? []).map(l => [l.ebay_item_id, l]))
      const productIds = (listings ?? []).filter(l => l.product_id).map(l => l.product_id as string)
      const productMap = new Map<string, { ebay_category_id: string | null; ebay_title: string | null; ebay_price: number | null; description: string | null }>()
      if (productIds.length > 0) {
        const { data: products } = await db.from('products').select('id, ebay_category_id, ebay_title, ebay_price, description').in('id', productIds)
        for (const p of products ?? []) productMap.set(p.id, p)
      }

      const stackResults = []
      for (const s of stackingItems ?? []) {
        const listing = listingMap.get(s.ebay_item_id)
        if (!listing) continue
        const product = listing.product_id ? productMap.get(listing.product_id) : null
        const r = await addFixedPriceItem(accessToken, {
          title: product?.ebay_title ?? listing.title ?? '',
          price: product?.ebay_price ?? listing.current_price ?? 0,
          categoryId: product?.ebay_category_id ?? '1',
          description: product?.description ?? '',
          pictureUrls: [],
          sku: `stack_${s.ebay_item_id}_${Date.now()}`,
          paymentProfileName: settings.payment_profile_name,
          returnProfileName: settings.return_profile_name,
          shippingProfileName: settings.shipping_profile_name,
        })
        stackResults.push(r)
        if (r.success) {
          await db.from('inventory_stacking')
            .update({ new_source_url: null, note: `stacked:${r.itemId}`, updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('ebay_item_id', s.ebay_item_id)
        }
      }
      userResult.stack = { total: stackResults.length, succeeded: stackResults.filter(r => r.success).length }

      await db.from('inventory_runs').insert({
        user_id: userId, run_type: 'auto_stack', status: 'completed',
        result_summary: userResult.stack,
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      })
    // ignore log errors
    }

    results.push(userResult)
  }

  return NextResponse.json({ ok: true, processed: results.length, results })
}
