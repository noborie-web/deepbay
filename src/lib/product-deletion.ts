import type { SupabaseClient } from '@supabase/supabase-js'

export const LISTED_PRODUCT_DELETE_ERROR = '出品済みの商品が含まれています。削除するとeBay側の紐付けが失われます。'

export interface ProductDeletionCandidate {
  id: string
  ebay_item_id: string | null
  ebay_title: string | null
  original_title: string
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
    .filter(product => product.ebay_item_id !== null || inventoryProductIds.has(product.id))
    .map(product => ({
      id: product.id,
      title: product.ebay_title ?? product.original_title,
    }))
}
