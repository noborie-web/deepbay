import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeSiteKeys } from './ebay-sites'

// ユーザー要望(2026-09-25): 出品アカウントを複数持ち、それぞれ独立して在庫管理
// したい。「混在しないよう細心の注意が必要」とのことなので、同期・価格改定・
// 取り下げはすべて「どのセラーの出品か」を明示して実行する。
export interface InventorySellerAccount {
  id: string
  seller_id: string
  display_name: string | null
  ebay_marketplace_id: string | null
  inventory_discovery_scanned_until: string | null
  inventory_sync_cursor_item_id: string | null
  // このセラーで出品しているサイト(US/UK/AU)
  listing_site_ids: string[]
}

/**
 * 在庫管理の対象セラー(eBay接続済み かつ inventory_enabled)を接続順に返す。
 */
export async function listInventorySellerAccounts(
  db: SupabaseClient,
  userId: string,
): Promise<InventorySellerAccount[]> {
  const { data, error } = await db
    .from('seller_accounts')
    .select('id, seller_id, display_name, ebay_marketplace_id, inventory_enabled, ebay_connected_at, inventory_discovery_scanned_until, inventory_sync_cursor_item_id, listing_site_ids')
    .eq('user_id', userId)
    .not('ebay_connected_at', 'is', null)
    .order('ebay_connected_at', { ascending: true })
  if (error) throw new Error(`出品アカウントの取得に失敗しました: ${error.message}`)
  return (data ?? [])
    .filter(row => row.inventory_enabled !== false)
    .map(row => ({
      id: row.id as string,
      seller_id: row.seller_id as string,
      display_name: (row.display_name as string | null) ?? null,
      ebay_marketplace_id: (row.ebay_marketplace_id as string | null) ?? null,
      inventory_discovery_scanned_until: (row.inventory_discovery_scanned_until as string | null) ?? null,
      inventory_sync_cursor_item_id: (row.inventory_sync_cursor_item_id as string | null) ?? null,
      listing_site_ids: normalizeSiteKeys(((row.listing_site_ids as string[] | null) ?? ['US']).join(',')),
    }))
}

export function sellerAccountLabel(account: { seller_id: string; display_name?: string | null }): string {
  return account.display_name?.trim() || account.seller_id
}
