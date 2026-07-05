import { NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'

async function getEbayToken(): Promise<string> {
  const clientId = process.env.EBAY_CLIENT_ID!
  const clientSecret = process.env.EBAY_CLIENT_SECRET!
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`eBay auth failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  return data.access_token
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenCategories(node: any, results: { id: string; name: string; parent_id: string | null; level: number }[] = [], level = 0, parentId: string | null = null) {
  if (node.category) {
    results.push({
      id: String(node.category.categoryId),
      name: node.category.categoryName,
      parent_id: parentId,
      level,
    })
  }
  if (node.childCategoryTreeNodes) {
    for (const child of node.childCategoryTreeNodes) {
      flattenCategories(child, results, level + 1, node.category?.categoryId ? String(node.category.categoryId) : null)
    }
  }
  return results
}

export async function POST() {
  try {
    const token = await getEbayToken()

    // US category tree (tree ID = 0)
    const res = await fetch('https://api.ebay.com/commerce/taxonomy/v1/category_tree/0', {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Taxonomy API failed: ${res.status}`)

    const tree = await res.json()
    const categories: { id: string; name: string; parent_id: string | null; level: number }[] = []

    for (const node of tree.rootCategoryNode?.childCategoryTreeNodes ?? []) {
      flattenCategories(node, categories, 1, null)
    }

    const admin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // 既存データを削除して再インポート
    await admin.from('ebay_categories').delete().neq('id', '')

    // 500件ずつに分割してinsert
    const chunkSize = 500
    let inserted = 0
    for (let i = 0; i < categories.length; i += chunkSize) {
      const { error } = await admin.from('ebay_categories').insert(categories.slice(i, i + chunkSize))
      if (error) throw new Error(`Insert failed at ${i}: ${error.message}`)
      inserted += Math.min(chunkSize, categories.length - i)
    }

    return NextResponse.json({ ok: true, total: categories.length, inserted })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
