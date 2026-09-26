import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Product, InventoryActiveListing } from '@/types/database'
import InventoryProductsSection from '@/components/inventory/InventoryProductsSection'
import { hasInventoryAuthentication } from '@/lib/inventory-auth'

function admin() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export default async function InventoryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const db = admin()
  // 実データで確認した不具合: 集計カードは表示用に取得した直近100件だけを
  // 数えていたため、総商品数が100で頭打ちになっていた。集計はDBの件数で行う。
  const countByStatus = (status?: string) => {
    let query = supabase.from('products').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
    if (status) query = query.eq('listing_status', status)
    return query
  }
  const [productsResult, listingsResult, settingsResult, totalCount, draftCount, listedCount, soldCount, delistedCount] = await Promise.all([
    supabase.from('products').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
    db.from('inventory_active_listings').select('*', { count: 'exact' }).eq('user_id', user.id).order('fetched_at', { ascending: false }).limit(50),
    db.from('inventory_settings').select('ebay_token').eq('user_id', user.id).maybeSingle(),
    countByStatus(),
    countByStatus('draft'),
    countByStatus('listed'),
    countByStatus('sold'),
    countByStatus('delisted'),
  ])

  // ユーザー要望(2026-09-26): UK/AUにも出品するので、出品中の内訳を
  // セラー×サイトで見たい。在庫一覧(取り下げ済みを除く)を集計する。
  const { data: siteRows } = await db
    .from('inventory_active_listings')
    .select('seller_account_id, site_id')
    .eq('user_id', user.id)
    .is('delisted_at', null)
  const { data: sellerRows } = await db
    .from('seller_accounts')
    .select('id, seller_id, display_name')
    .eq('user_id', user.id)
  const sellerNames = new Map((sellerRows ?? []).map(row => [
    row.id as string,
    ((row.display_name as string | null)?.trim() || (row.seller_id as string)),
  ]))
  const siteBreakdownMap = new Map<string, number>()
  for (const row of siteRows ?? []) {
    const seller = sellerNames.get(row.seller_account_id as string) ?? '（セラー不明）'
    const site = ((row.site_id as string | null) ?? 'US').toUpperCase()
    const key = `${seller}\u0000${site}`
    siteBreakdownMap.set(key, (siteBreakdownMap.get(key) ?? 0) + 1)
  }
  const siteBreakdown = Array.from(siteBreakdownMap.entries())
    .map(([key, count]) => {
      const [seller, site] = key.split('\u0000')
      return { seller, site, count }
    })
    .sort((a, b) => b.count - a.count || a.seller.localeCompare(b.seller))

  const items = (productsResult.data ?? []) as Product[]
  const activeListings = (listingsResult.data ?? []) as InventoryActiveListing[]
  const hasToken = await hasInventoryAuthentication(db, user.id, settingsResult.data?.ebay_token)

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold mb-6 text-gray-800">在庫管理</h1>

      {/* 集計カード(クリックで絞り込み) + eBay在庫管理パネル + 商品テーブル
          (総商品数・下書きは選択削除可)。カード・パネル・テーブルは絞り込み
          状態を共有するため、サーバーコンポーネントのこのページから
          データだけを渡し、実際の描画は1つのクライアントコンポーネント
          (InventoryProductsSection)にまとめている(childrenに関数を渡すと
          サーバー/クライアント境界を越えられずクラッシュするため)。 */}
      <InventoryProductsSection
        items={items}
        listings={activeListings}
        listingCount={listingsResult.count ?? activeListings.length}
        statusCounts={{
          total: totalCount.count ?? items.length,
          draft: draftCount.count ?? 0,
          listed: listedCount.count ?? 0,
          sold: soldCount.count ?? 0,
          delisted: delistedCount.count ?? 0,
        }}
        siteBreakdown={siteBreakdown}
        hasToken={hasToken}
      />
    </div>
  )
}
