import type { SupabaseClient } from '@supabase/supabase-js'
import { chunkIds } from '@/lib/db-chunk'

export const LISTED_PRODUCT_DELETE_ERROR = '出品済み（またはCSVで出品した可能性がある）商品が含まれています。削除するとeBay側の紐付けと仕入先URLが失われます。'

export interface ProductDeletionCandidate {
  id: string
  ebay_item_id: string | null
  ebay_title: string | null
  original_title: string
  // 本番で判明した問題(2026-10-09): CSV出品はeBayからItemIDが戻らないので
  // ebay_item_id が null のままで、在庫管理にも載らない。そのため安全装置が
  // 素通りし、eBayに出品が生きている商品を削除できてしまっていた(626件)。
  // 出品CSVに出した商品は「出品した可能性がある」として扱う。
  listing_csv_exported_at?: string | null
}

export interface BlockedProductDeletion {
  id: string
  title: string
}

export async function findBlockedProductDeletions(
  db: SupabaseClient,
  userId: string,
  products: ProductDeletionCandidate[],
): Promise<BlockedProductDeletion[]> {
  if (products.length === 0) return []

  // 本番で確認した不具合(2026-10-22): `.in('product_id', 全商品ID)` は
  // 100件を超えるとURLが長すぎて400になる。安全側(削除されない)には倒れるが、
  // 100件超の抽出は削除しようとすると必ずエラーになっていた
  // (現存する「タイトル ファミコン」590件・「スーパーファミコン」286件が該当)。
  const inventoryProductIds = new Set<string>()
  for (const chunk of chunkIds(products.map(product => product.id))) {
    const { data, error } = await db
      .from('inventory_active_listings')
      .select('product_id')
      .eq('user_id', userId)
      .in('product_id', chunk)
    // エラーは必ず投げる。握りつぶすと「出品されていない」と誤判定して
    // 出品中の商品を削除してしまう(安全装置が無言で無効になる)。
    if (error) throw new Error(error.message)
    for (const listing of data ?? []) {
      if (typeof listing.product_id === 'string') inventoryProductIds.add(listing.product_id)
    }
  }

  return products
    .filter(product => product.ebay_item_id !== null
      || inventoryProductIds.has(product.id)
      || (product.listing_csv_exported_at ?? null) !== null)
    .map(product => ({
      id: product.id,
      title: product.ebay_title ?? product.original_title,
    }))
}
