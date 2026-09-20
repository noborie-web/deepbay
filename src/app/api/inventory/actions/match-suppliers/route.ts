import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { findScraper } from '@/lib/scrapers'
import { findSupplierMatch, type SupplierCandidate } from '@/lib/supplier-match'

// ユーザー要望(事故復旧): 仕入先URLが消えた(eBayのURLが仮に入っている)商品に
// ついて、元タイトル+仕入価格でメルカリを検索して仕入先URLを復元する。
//  mode=status : 未設定(照合対象)の件数
//  mode=run    : 対象を limit 件ずつ照合。確度が高いものは自動で設定し、
//                それ以外は候補付きで返す(画面で採用/手動入力)
//  mode=apply  : { product_id, source_url } の配列を設定(手動採用)
export const maxDuration = 300

const RUN_LIMIT_MAX = 8

function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// 対応スクレイパーが無いURL(= eBayの仮URL 等)は仕入先未設定とみなす
function isPlaceholderSource(url: string | null): boolean {
  if (!url) return true
  return !findScraper(url)
}

interface Row { id: string; ebay_item_id: string | null; original_title: string; original_price: number | null; purchase_price_jpy: number | null; source_url: string | null; listing_status: string; ebay_images: string[] | null }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { mode?: string; limit?: number; apply?: unknown; skip_ids?: unknown; product_id?: unknown }
  const mode = body.mode ?? 'status'
  const db = admin()

  // 仕入先がメルカリ上に見つからない(売れた/削除された)商品は、仕入れが
  // できないので在庫切れ扱いにする(在庫0 → 即取り下げの対象になる)。
  if (mode === 'mark_unavailable') {
    const productId = typeof body.product_id === 'string' ? body.product_id : ''
    if (!productId) return NextResponse.json({ error: 'product_id を指定してください' }, { status: 400 })
    const now = new Date().toISOString()
    const { error } = await db
      .from('inventory_active_listings')
      .update({ quantity: 0, supplier_checked_at: now, updated_at: now })
      .eq('user_id', user.id)
      .eq('product_id', productId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (mode === 'apply') {
    const entries = Array.isArray(body.apply) ? body.apply as Array<{ product_id?: string; source_url?: string }> : []
    let applied = 0
    for (const entry of entries) {
      const url = String(entry.source_url ?? '').trim()
      const scraper = findScraper(url)
      if (!entry.product_id || !scraper) continue
      const itemId = url.match(/item\/(m\d+)/)?.[1] ?? null
      const { error } = await db
        .from('products')
        .update({ source_url: url, source_site: scraper.siteKey, source_item_id: itemId, updated_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .eq('id', entry.product_id)
      if (!error) applied += 1
    }
    return NextResponse.json({ ok: true, applied })
  }

  const { data, error } = await db
    .from('products')
    .select('id, ebay_item_id, original_title, original_price, purchase_price_jpy, source_url, listing_status, ebay_images')
    .eq('user_id', user.id)
    .not('ebay_item_id', 'is', null)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const skipIds = new Set(Array.isArray(body.skip_ids) ? (body.skip_ids as unknown[]).map(String) : [])
  const targets = ((data ?? []) as Row[]).filter(r => isPlaceholderSource(r.source_url) && !skipIds.has(r.id))

  if (mode === 'status') return NextResponse.json({ ok: true, pending: targets.length })
  if (mode !== 'run') return NextResponse.json({ error: `不明な mode: ${mode}` }, { status: 400 })

  const limit = Math.min(Math.max(1, Math.floor(body.limit ?? RUN_LIMIT_MAX)), RUN_LIMIT_MAX)
  const batch = targets.slice(0, limit)
  const matched: Array<{ product_id: string; ebay_item_id: string | null; title: string; source_url: string; candidate_title: string; price: number | null }> = []
  const review: Array<{ product_id: string; ebay_item_id: string | null; title: string; price_jpy: number | null; listing_status: string; image_url: string | null; candidates: SupplierCandidate[] }> = []
  const failed: Array<{ product_id: string; title: string; error: string }> = []

  const concurrency = 3
  let index = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
    while (index < batch.length) {
      const row = batch[index++]
      const priceJpy = row.original_price ?? row.purchase_price_jpy ?? null
      try {
        const result = await findSupplierMatch({ title: row.original_title, priceJpy })
        if (result.confident && result.best) {
          const itemId = result.best.sourceUrl.match(/item\/(m\d+)/)?.[1] ?? null
          const { error: updateError } = await db
            .from('products')
            .update({ source_url: result.best.sourceUrl, source_site: 'mercari', source_item_id: itemId, updated_at: new Date().toISOString() })
            .eq('user_id', user.id)
            .eq('id', row.id)
          if (updateError) throw new Error(updateError.message)
          matched.push({ product_id: row.id, ebay_item_id: row.ebay_item_id, title: row.original_title, source_url: result.best.sourceUrl, candidate_title: result.best.title, price: result.best.price })
        } else {
          review.push({ product_id: row.id, ebay_item_id: row.ebay_item_id, title: row.original_title, price_jpy: priceJpy, listing_status: row.listing_status, image_url: row.ebay_images?.[0] ?? null, candidates: result.candidates.slice(0, 3) })
        }
      } catch (error) {
        failed.push({ product_id: row.id, title: row.original_title, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }))

  const remaining = Math.max(0, targets.length - batch.length)
  return NextResponse.json({ ok: true, matched, review, failed, processed: batch.length, remaining, done: remaining <= 0 })
}
