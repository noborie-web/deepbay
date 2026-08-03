import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const db = admin()

  const { data: config } = await db
    .from('inventory_duplicate_check_configs')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!config) return NextResponse.json({ error: '設定が見つかりません' }, { status: 404 })

  // アクティブリスティングをすべて取得
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, custom_label, product_id')
    .eq('user_id', user.id)

  // 対応するproductのsource_urlを取得
  const productIds = (listings ?? []).filter(l => l.product_id).map(l => l.product_id as string)
  const productUrlMap = new Map<string, string>()

  if (productIds.length > 0) {
    const { data: products } = await db
      .from('products')
      .select('id, source_url')
      .in('id', productIds)
    for (const p of products ?? []) {
      if (p.source_url) productUrlMap.set(p.id, p.source_url)
    }
  }

  const checkColumns = config.check_columns as string[]

  // source_urlの重複チェック
  const urlCount = new Map<string, string[]>() // url -> [ebay_item_id, ...]
  const titleCount = new Map<string, string[]>() // title -> [ebay_item_id, ...]

  for (const l of listings ?? []) {
    if (checkColumns.includes('url') && l.product_id) {
      const url = productUrlMap.get(l.product_id)
      if (url) {
        const existing = urlCount.get(url) ?? []
        existing.push(l.ebay_item_id)
        urlCount.set(url, existing)
      }
    }
    if (checkColumns.includes('title') && l.title) {
      const title = l.title.trim()
      const existing = titleCount.get(title) ?? []
      existing.push(l.ebay_item_id)
      titleCount.set(title, existing)
    }
  }

  // 重複しているitem_idを収集（最初の1件を残して残りをEnd対象）
  const duplicateItems: Array<{ ebay_item_id: string; reason: string }> = []
  const seenIds = new Set<string>()

  if (checkColumns.includes('url')) {
    for (const [, ids] of urlCount) {
      if (ids.length > 1) {
        for (const id of ids.slice(1)) {
          if (!seenIds.has(id)) {
            duplicateItems.push({ ebay_item_id: id, reason: 'duplicate_url' })
            seenIds.add(id)
          }
        }
      }
    }
  }

  if (checkColumns.includes('title')) {
    for (const [, ids] of titleCount) {
      if (ids.length > 1) {
        for (const id of ids.slice(1)) {
          if (!seenIds.has(id)) {
            duplicateItems.push({ ebay_item_id: id, reason: 'duplicate_title' })
            seenIds.add(id)
          }
        }
      }
    }
  }

  // 設定の最終チェック日時と件数を更新
  const now = new Date().toISOString()
  await db
    .from('inventory_duplicate_check_configs')
    .update({ last_checked_at: now, last_found_count: duplicateItems.length, updated_at: now })
    .eq('id', id)

  return NextResponse.json({ ok: true, duplicates: duplicateItems, found: duplicateItems.length })
}
