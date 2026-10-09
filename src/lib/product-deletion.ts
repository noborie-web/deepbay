import type { SupabaseClient } from '@supabase/supabase-js'

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

  const { data: inventoryListings, error } = await db
    .from('inventory_active_listings')
    .select('product_id')
    .eq('user_id', userId)
    .in('product_id', products.map(product => product.id))

  if (error) throw new Error(error.message)

  const inventoryProductIds = new Set(
    (inventoryListings ?? [])
      .map(listing => listing.product_id)
      .filter((productId): productId is string => typeof productId === 'string'),
  )

  return products
    .filter(product => product.ebay_item_id !== null
      || inventoryProductIds.has(product.id)
      || (product.listing_csv_exported_at ?? null) !== null)
    .map(product => ({
      id: product.id,
      title: product.ebay_title ?? product.original_title,
    }))
}
