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
  const [productsResult, listingsResult, settingsResult] = await Promise.all([
    supabase.from('products').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(100),
    db.from('inventory_active_listings').select('*', { count: 'exact' }).eq('user_id', user.id).order('fetched_at', { ascending: false }).limit(50),
    db.from('inventory_settings').select('ebay_token').eq('user_id', user.id).maybeSingle(),
  ])

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
        hasToken={hasToken}
      />
    </div>
  )
}
