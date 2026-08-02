import type { Product } from '@/types/database'

const LOOKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const SOURCE_LOOKUP_CODE_PATTERN = /^ele_\d{8}_[A-HJ-NP-Z2-9]{16}$/

type LookupProduct = Pick<
  Product,
  'id' | 'source_url' | 'source_site' | 'original_title' | 'source_lookup_code'
>

interface LookupRow {
  product_id: string | null
  lookup_code: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any

export function createSourceLookupCode(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const random = [...bytes]
    .map((byte) => LOOKUP_ALPHABET[byte % LOOKUP_ALPHABET.length])
    .join('')
  return `ele_${date}_${random}`
}

export function normalizeSourceLookupCode(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^ele_(\d{8})_([a-hj-np-z2-9]{16})$/i)
  return match ? `ele_${match[1]}_${match[2].toUpperCase()}` : trimmed
}

/**
 * 商品ごとに一度だけ推測不能なDBK-IDを発行する。
 * URLはCSVへ埋め込まず、対応表だけをDBに保存する。
 */
export async function ensureSourceLookupCodes(
  supabase: SupabaseLike,
  userId: string,
  products: LookupProduct[],
): Promise<Map<string, string>> {
  const productIds = [...new Set(products.map((product) => product.id))]
  const codes = new Map<string, string>()

  for (const product of products) {
    if (product.source_lookup_code && SOURCE_LOOKUP_CODE_PATTERN.test(product.source_lookup_code)) {
      codes.set(product.id, product.source_lookup_code)
    }
  }

  for (let offset = 0; offset < productIds.length; offset += 100) {
    const chunk = productIds.slice(offset, offset + 100)
    const { data, error } = await supabase
      .from('source_url_lookup_codes')
      .select('product_id, lookup_code')
      .eq('user_id', userId)
      .in('product_id', chunk)
    if (error) throw new Error(`DBK-IDの確認に失敗しました: ${error.message}`)
    for (const row of (data ?? []) as LookupRow[]) {
      if (row.product_id) codes.set(row.product_id, row.lookup_code)
    }
  }

  const missing = products.filter((product) => !codes.has(product.id))
  if (missing.length > 0) {
    const rows = missing.map((product) => ({
      user_id: userId,
      product_id: product.id,
      lookup_code: createSourceLookupCode(),
      source_url: product.source_url,
      source_site: product.source_site,
      source_title: product.original_title,
    }))

    for (let offset = 0; offset < rows.length; offset += 100) {
      const { error } = await supabase
        .from('source_url_lookup_codes')
        .upsert(rows.slice(offset, offset + 100), {
          onConflict: 'user_id,product_id',
          ignoreDuplicates: true,
        })
      if (error) throw new Error(`DBK-IDの保存に失敗しました: ${error.message}`)
    }

    for (let offset = 0; offset < productIds.length; offset += 100) {
      const chunk = productIds.slice(offset, offset + 100)
      const { data, error } = await supabase
        .from('source_url_lookup_codes')
        .select('product_id, lookup_code')
        .eq('user_id', userId)
        .in('product_id', chunk)
      if (error) throw new Error(`DBK-IDの再確認に失敗しました: ${error.message}`)
      for (const row of (data ?? []) as LookupRow[]) {
        if (row.product_id) codes.set(row.product_id, row.lookup_code)
      }
    }
  }

  if (codes.size !== productIds.length) {
    throw new Error('一部商品のDBK-IDを発行できませんでした')
  }
  return codes
}

export function attachSourceLookupCodes(
  products: Product[],
  codes: Map<string, string>,
): Product[] {
  return products.map((product) => ({
    ...product,
    source_lookup_code: codes.get(product.id) ?? null,
  }))
}
