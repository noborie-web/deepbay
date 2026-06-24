import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Product } from '@/types/database'

export default async function InventoryPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100)

  const items = (products ?? []) as Product[]

  const counts = {
    total: items.length,
    draft: items.filter((p) => p.listing_status === 'draft').length,
    listed: items.filter((p) => p.listing_status === 'listed').length,
    sold: items.filter((p) => p.listing_status === 'sold').length,
  }

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold mb-6 text-gray-800">在庫管理</h1>

      {/* 集計 */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: '総商品数', value: counts.total, color: 'text-gray-800' },
          { label: '下書き', value: counts.draft, color: 'text-gray-500' },
          { label: '出品中', value: counts.listed, color: 'text-blue-600' },
          { label: '売却済み', value: counts.sold, color: 'text-green-600' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white border rounded-md px-5 py-4">
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-semibold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* 商品テーブル */}
      <div className="bg-white border rounded-md overflow-hidden">
        <div className="grid grid-cols-[60px_1fr_100px_120px_100px_120px] gap-4 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
          <span>画像</span>
          <span>商品名</span>
          <span>元価格</span>
          <span>eBay価格</span>
          <span>ステータス</span>
          <span>登録日</span>
        </div>

        {items.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">在庫がありません</div>
        ) : (
          items.map((product) => (
            <div
              key={product.id}
              className="grid grid-cols-[60px_1fr_100px_120px_100px_120px] gap-4 items-center px-4 py-3 border-b last:border-0 hover:bg-gray-50 text-sm"
            >
              {/* 画像 */}
              <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden">
                {product.original_images[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={product.original_images[0]}
                    alt={product.original_title}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>

              {/* タイトル */}
              <div>
                <p className="font-medium text-gray-800 truncate">{product.ebay_title ?? product.original_title}</p>
                <p className="text-xs text-gray-400 truncate">{product.source_url}</p>
              </div>

              {/* 元価格 */}
              <div className="text-gray-600">
                {product.original_price != null ? `¥${product.original_price.toLocaleString()}` : '—'}
              </div>

              {/* eBay価格 */}
              <div className="text-gray-800 font-medium">
                {product.ebay_price != null ? `¥${product.ebay_price.toLocaleString()}` : '—'}
              </div>

              {/* ステータス */}
              <div>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  product.listing_status === 'listed' ? 'bg-blue-100 text-blue-700' :
                  product.listing_status === 'sold' ? 'bg-green-100 text-green-700' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {product.listing_status === 'draft' ? '下書き' :
                   product.listing_status === 'listed' ? '出品中' :
                   product.listing_status === 'sold' ? '売却済み' : '取下げ'}
                </span>
              </div>

              {/* 登録日 */}
              <div className="text-xs text-gray-400">
                {new Date(product.created_at).toLocaleDateString('ja-JP')}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
