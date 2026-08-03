// 監視モード: CSVファイルを生成するが、eBay側への変更は実行しない
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

function buildCsv(rows: string[][]): string {
  return rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const fileType: string = body.file_type ?? 'end_items' // end_items | diff | revise | duplicate
  const diffColumns: string[] = body.diff_columns ?? ['title', 'price']

  const db = admin()

  // アクティブリスティングを取得
  const { data: listings } = await db
    .from('inventory_active_listings')
    .select('ebay_item_id, title, custom_label, current_price, quantity, product_id, fetched_at')
    .eq('user_id', user.id)

  // 対応するproductを取得
  const productIds = (listings ?? []).filter(l => l.product_id).map(l => l.product_id as string)
  const productMap = new Map<string, { source_url: string | null; ebay_title: string | null; ebay_price: number | null; original_title: string | null }>()

  if (productIds.length > 0) {
    const { data: products } = await db
      .from('products')
      .select('id, source_url, ebay_title, ebay_price, original_title')
      .in('id', productIds)
    for (const p of products ?? []) {
      productMap.set(p.id, p)
    }
  }

  const seller = user.email?.split('@')[0] ?? 'user'
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  let csv = ''
  let filename = ''

  if (fileType === 'end_items') {
    // 取り下げファイル: quantity=0 のアイテム
    const rows: string[][] = [['#INFO', 'col1', 'col2', 'col3', 'col4']]
    rows.push(['Action', 'Item number', 'Available quantity', 'EndCode', 'reason'])
    for (const l of listings ?? []) {
      if ((l.quantity ?? 1) === 0) {
        // Revise (quantity=0) or End (NotAvailable) based on listing status
        if (l.product_id) {
          rows.push(['Revise', l.ebay_item_id, '0', '', 'sold_out'])
        } else {
          rows.push(['End', l.ebay_item_id, '', 'NotAvailable', 'sold_out'])
        }
      }
    }
    csv = buildCsv(rows)
    filename = `${seller}_end_items_${dateStr}.csv`

  } else if (fileType === 'diff') {
    // 差分検知ファイル: title/price の差分
    const rows: string[][] = [['1_item_id', '2_url', '3_旧タイトル', '4_最新タイトル', '5_旧価格', '6_最新価格', 'diff_detail']]
    for (const l of listings ?? []) {
      if (!l.product_id) continue
      const product = productMap.get(l.product_id)
      if (!product) continue

      const diffs: string[] = []
      const oldTitle = l.title ?? ''
      const newTitle = product.ebay_title ?? product.original_title ?? ''
      const oldPrice = l.current_price ?? 0
      const newPrice = product.ebay_price ?? 0

      if (diffColumns.includes('title') && oldTitle !== newTitle && newTitle) {
        diffs.push('title')
      }
      if (diffColumns.includes('price') && newPrice > 0 && Math.abs(oldPrice - newPrice) > 1) {
        diffs.push('price')
      }

      if (diffs.length > 0) {
        rows.push([
          l.ebay_item_id,
          product.source_url ?? '',
          oldTitle,
          newTitle,
          String(Math.round(oldPrice)),
          String(newPrice),
          JSON.stringify(diffs),
        ])
      }
    }
    csv = buildCsv(rows)
    filename = `${seller}_diff_${dateStr}.csv`

  } else if (fileType === 'revise') {
    // 価格改定ファイル
    const rows: string[][] = [['#INFO', 'col1', 'col2', 'col3', 'col4']]
    rows.push(['Action', 'Item number', 'Start price', '変更前価格', '変更価格差分'])
    for (const l of listings ?? []) {
      if (!l.product_id || !l.current_price) continue
      const product = productMap.get(l.product_id)
      if (!product?.ebay_price) continue
      const newPrice = product.ebay_price
      const oldPrice = l.current_price
      const diff = Math.round((newPrice - oldPrice) * 100) / 100
      if (Math.abs(diff) > 0.5) {
        rows.push(['Revise', l.ebay_item_id, String(newPrice), String(oldPrice), String(diff)])
      }
    }
    csv = buildCsv(rows)
    filename = `${seller}_revise_${dateStr}.csv`

  } else if (fileType === 'duplicate') {
    // 重複チェックファイル（重複なしの場合はヘッダーのみ）
    const rows: string[][] = [['#INFO', 'col1', 'col2', 'col3', 'col4', 'col5']]
    rows.push(['Action', 'Item number', 'EndCode', 'Available quantity', 'master_seller_id', 'reason'])
    // 重複検知: same source_url or same title
    const urlToItems = new Map<string, string[]>()
    for (const l of listings ?? []) {
      if (!l.product_id) continue
      const product = productMap.get(l.product_id)
      const url = product?.source_url
      if (!url) continue
      const existing = urlToItems.get(url) ?? []
      existing.push(l.ebay_item_id)
      urlToItems.set(url, existing)
    }
    const seenIds = new Set<string>()
    for (const [, ids] of urlToItems) {
      if (ids.length > 1) {
        for (const itemId of ids.slice(1)) {
          if (!seenIds.has(itemId)) {
            rows.push(['End', itemId, 'NotAvailable', '', seller, 'duplicate'])
            seenIds.add(itemId)
          }
        }
      }
    }
    csv = buildCsv(rows)
    filename = `${seller}_duplicate_${dateStr}.csv`
  }

  return NextResponse.json({ csv: '﻿' + csv, filename })
}
