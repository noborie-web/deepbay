import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { reviseInventoryStatusBatch } from '@/lib/ebay-actions'
import { applyRevisedPrices } from '@/lib/inventory-sync'
import { createInventoryTokenResolver } from '@/lib/inventory-token-resolver'
import { decideSiteRevisePrice, loadJpyRates } from '@/lib/inventory-site-pricing'
import { currencyForSite } from '@/lib/ebay-sites'
import { adjustedJpyRate, loadPricingModel, sitePriceAdjustment } from '@/lib/inventory-pricing'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET: 価格改定対象リストのプレビュー
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, current_price, product_id, site_id, currency')
    .eq('user_id', user.id)
    .not('product_id', 'is', null)

  const productIds = (listings ?? []).map(l => l.product_id as string)
  const productMap = new Map<string, { ebay_price: number | null; pricing_jpy_per_usd: number | null }>()

  if (productIds.length > 0) {
    const { data: products } = await db
      .from('products')
      .select('id, ebay_price, pricing_jpy_per_usd')
      .in('id', productIds)
    for (const p of products ?? []) productMap.set(p.id, p)
  }

  // UK/AU出品は、実行時と同じ換算(維持した利益額→出品通貨)でプレビューする。
  // ここでUSD価格のまま並べると、実行結果と食い違って確認の意味がなくなる。
  const pricingModel = await loadPricingModel(db, user.id)
  const rates = await loadJpyRates(
    (listings ?? []).map(l => ((l.currency as string | null) ?? 'USD')),
    (currency, rate, jpyPerUsd) => adjustedJpyRate(pricingModel, currency, rate, jpyPerUsd),
  )

  const items = (listings ?? []).flatMap(l => {
    const p = productMap.get(l.product_id!)
    const currency = ((l.currency as string | null) ?? 'USD').toUpperCase()
    const decision = decideSiteRevisePrice({
      currentPrice: l.current_price as number | null,
      usdPrice: p?.ebay_price ?? null,
      jpyPerUsd: p?.pricing_jpy_per_usd ?? null,
      siteId: (l.site_id as string | null) ?? 'US',
      jpyPerCurrency: rates.get(currency) ?? null,
      priceAdjustment: sitePriceAdjustment(pricingModel, (l.site_id as string | null) ?? 'US'),
    })
    if (decision.action !== 'revise') return []
    const before = Number(l.current_price)
    return [{
      ebay_item_id: l.ebay_item_id,
      title: l.title,
      old_price: before,
      new_price: decision.price,
      currency: decision.currency,
      site_id: (l.site_id as string | null) ?? 'US',
      diff: Math.round((decision.price - before) * 100) / 100,
    }]
  })

  return NextResponse.json({ items, count: items.length })
}

// POST: 価格改定実行
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const itemIds: string[] | undefined = Array.isArray(body.item_ids) ? body.item_ids : undefined

  const db = admin()

  const { data: settings } = await db
    .from('inventory_settings')
    .select('ebay_token, ebay_refresh_token, ebay_token_expires_at')
    .eq('user_id', user.id)
    .maybeSingle()

  const tokenResolver = await createInventoryTokenResolver(db, user.id, settings ?? {})

  let query = db
    .from('inventory_active_listings')
    .select('ebay_item_id, current_price, product_id, seller_account_id, site_id, currency')
    .eq('user_id', user.id)
    .not('product_id', 'is', null)

  if (itemIds) query = query.in('ebay_item_id', itemIds)

  const { data: listings } = await query

  const productIds = (listings ?? []).map(l => l.product_id as string)
  const productMap = new Map<string, { ebay_price: number | null; pricing_jpy_per_usd: number | null }>()
  if (productIds.length > 0) {
    const { data: products } = await db.from('products').select('id, ebay_price, pricing_jpy_per_usd').in('id', productIds)
    for (const p of products ?? []) productMap.set(p.id, p)
  }
  // UK/AU出品はUSD価格を出品通貨へ換算する(維持している利益額はそのまま)
  const pricingModel = await loadPricingModel(db, user.id)
  const rates = await loadJpyRates(
    (listings ?? []).map(l => ((l.currency as string | null) ?? 'USD')),
    (currency, rate, jpyPerUsd) => adjustedJpyRate(pricingModel, currency, rate, jpyPerUsd),
  )

  const entries: Array<{ itemId: string; price: number; siteId: string | null; sellerAccountId: string | null }> = []
  const beforePrices = new Map<string, number>()
  // 換算できない(レート未取得)・不自然に大きく下がる場合は送らず件数を残す。
  let skippedNoRate = 0
  let guarded = 0
  let skippedUnknownSeller = 0
  for (const l of listings ?? []) {
    const p = productMap.get(l.product_id!)
    const currency = ((l.currency as string | null) ?? 'USD').toUpperCase()
    const decision = decideSiteRevisePrice({
      currentPrice: l.current_price as number | null,
      usdPrice: p?.ebay_price ?? null,
      jpyPerUsd: p?.pricing_jpy_per_usd ?? null,
      siteId: (l.site_id as string | null) ?? 'US',
      jpyPerCurrency: rates.get(currency) ?? null,
      priceAdjustment: sitePriceAdjustment(pricingModel, (l.site_id as string | null) ?? 'US'),
    })
    if (decision.action === 'skip') {
      if (decision.reason === 'no_rate') skippedNoRate++
      if (decision.reason === 'guarded') guarded++
      continue
    }
    if (!tokenResolver.tokenFor(l.seller_account_id as string | null)) { skippedUnknownSeller++; continue }
    entries.push({
      itemId: l.ebay_item_id as string,
      price: decision.price,
      siteId: (l.site_id as string | null) ?? 'US',
      sellerAccountId: (l.seller_account_id as string | null) ?? null,
    })
    beforePrices.set(l.ebay_item_id as string, Number(l.current_price))
  }
  // 4件ずつまとめて並行に送る(件数が多くても時間内に終わるように)。
  // トークンはセラーごとに違うため、セラー単位で送る。
  const results: Array<{ itemId: string; success: boolean; error?: string }> = []
  for (const sellerAccountId of new Set(entries.map(e => e.sellerAccountId))) {
    const token = tokenResolver.tokenFor(sellerAccountId)
    if (!token) continue
    const batch = await reviseInventoryStatusBatch(token, entries.filter(e => e.sellerAccountId === sellerAccountId))
    results.push(...batch.results)
  }
  const items = results.map(r => {
    const after = entries.find(e => e.itemId === r.itemId)?.price ?? null
    const before = beforePrices.get(r.itemId) ?? null
    return { ebay_item_id: r.itemId, price_before: before, price_after: after, diff: after !== null && before !== null ? Math.round((after - before) * 100) / 100 : null, success: r.success, error: r.error ?? null }
  })

  try {
    await applyRevisedPrices(db, user.id, results.filter(r => r.success).map(r => {
      const entry = entries.find(e => e.itemId === r.itemId)
      return {
        ebay_item_id: r.itemId,
        price: entry?.price ?? 0,
        jpy_per_currency: entry ? rates.get(currencyForSite(entry.siteId)) ?? null : null,
      }
    }).filter(r => r.price > 0))
  } catch (error) {
    console.warn('[revise-price] revised price bookkeeping failed:', error instanceof Error ? error.message : error)
  }
  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const runSummary = summarizeInventoryActionRun(results)

  await db.from('inventory_runs').insert({
    user_id: user.id,
    run_type: 'revise_price',
    status: runSummary.status,
    error_message: runSummary.errorMessage,
    result_summary: {
      total: results.length, succeeded, failed: failed.map(f => ({ id: f.itemId, error: f.error })),
      skipped_no_rate: skippedNoRate, guarded, skipped_unknown_seller: skippedUnknownSeller, items,
    },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  })
    // ignore log errors

  return NextResponse.json({
    ok: true, total: results.length, succeeded, failed,
    skipped_no_rate: skippedNoRate, guarded, skipped_unknown_seller: skippedUnknownSeller,
  })
}
