'use client'

import { useState } from 'react'
import type { Product, InventoryActiveListing } from '@/types/database'
import InventoryPanel from './InventoryPanel'

export type FilterKey = 'total' | 'draft' | 'listed' | 'sold'

const FILTERS: { key: FilterKey; label: string; color: string; match?: (p: Product) => boolean }[] = [
  { key: 'total', label: '総商品数', color: 'text-gray-800' },
  { key: 'draft', label: '下書き', color: 'text-gray-500', match: (p) => p.listing_status === 'draft' },
  { key: 'listed', label: '出品中', color: 'text-blue-600', match: (p) => p.listing_status === 'listed' },
  { key: 'sold', label: '売却済み', color: 'text-green-600', match: (p) => p.listing_status === 'sold' },
]

// ユーザー要望: 「総商品数・下書き・出品中・売却済み」の集計カードをクリック
// すると、その条件に絞って表示できるようにしてほしい。加えて「総商品数」
// 「下書き」の2つは、表示中の商品をチェックして一括削除できるように
// してほしい(出品中・売却済みは、既存の削除APIが出品済み商品の削除を
// ブロックする仕様のため、選択削除の対象外とする)。
export default function InventoryProductsSection({ items, listings, listingCount, hasToken }: {
  items: Product[]
  // eBay在庫管理パネル(InventoryPanel)は絞り込み条件(filter)を
  // statusFilterとして受け取り、「eBay商品一覧」タブも同じ条件で絞り込む。
  // page.tsx(サーバーコンポーネント)からInventoryPanelを関数として
  // childrenで渡すとRSC境界を越えられずクラッシュするため、この
  // クライアントコンポーネント側でInventoryPanelを直接描画する。
  listings: InventoryActiveListing[]
  listingCount: number
  hasToken: boolean
}) {
  const [productList, setProductList] = useState(items)
  const [filter, setFilter] = useState<FilterKey>('total')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)

  const counts = {
    total: productList.length,
    draft: productList.filter((p) => p.listing_status === 'draft').length,
    listed: productList.filter((p) => p.listing_status === 'listed').length,
    sold: productList.filter((p) => p.listing_status === 'sold').length,
  }

  const activeFilterDef = FILTERS.find((f) => f.key === filter)!
  const filtered = activeFilterDef.match ? productList.filter(activeFilterDef.match) : productList

  const selectionEnabled = filter === 'total' || filter === 'draft'
  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))

  function selectFilter(key: FilterKey) {
    setFilter(key)
    setSelected(new Set())
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(filtered.map((p) => p.id)))
  }

  async function deleteSelected() {
    if (selected.size === 0 || deleting) return
    if (!confirm(`選択した${selected.size}件を削除しますか？`)) return

    setDeleting(true)
    const targets = productList.filter((p) => selected.has(p.id))
    const succeededIds: string[] = []
    const blockedTitles: string[] = []

    try {
      for (const product of targets) {
        if (!product.extraction_id) {
          blockedTitles.push(`${product.ebay_title ?? product.original_title}(抽出情報が見つかりません)`)
          continue
        }
        const res = await fetch(`/api/products/${product.extraction_id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: product.id }),
        })
        if (res.ok) {
          succeededIds.push(product.id)
        } else if (res.status === 409) {
          blockedTitles.push(product.ebay_title ?? product.original_title)
        }
      }

      if (succeededIds.length > 0) {
        setProductList((prev) => prev.filter((p) => !succeededIds.includes(p.id)))
      }
      setSelected(new Set())

      if (blockedTitles.length > 0) {
        alert([
          `以下の${blockedTitles.length}件は既に出品済みのため削除できませんでした(eBay側のリスティングは削除されません):`,
          blockedTitles.map((t) => `・${t}`).join('\n'),
          '出品済みの商品を削除したい場合は、商品編集画面から個別に削除してください。',
        ].join('\n\n'))
      }
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      {/* 集計 */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {FILTERS.map(({ key, label, color }) => (
          <button
            key={key}
            type="button"
            onClick={() => selectFilter(key)}
            className={`text-left bg-white border rounded-md px-5 py-4 transition-colors hover:bg-gray-50 ${
              filter === key ? 'border-blue-400 ring-1 ring-blue-200' : ''
            }`}
          >
            <p className="text-xs text-gray-500 mb-1">{label}</p>
            <p className={`text-2xl font-semibold ${color}`}>{counts[key]}</p>
          </button>
        ))}
      </div>

      <InventoryPanel listings={listings} listingCount={listingCount} hasToken={hasToken} statusFilter={filter} />

      {/* 商品テーブル */}
      <div className="bg-white border rounded-md overflow-hidden">
        {selectionEnabled && (
          <div className="flex items-center justify-between gap-3 px-4 py-2 bg-gray-50 border-b">
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} disabled={filtered.length === 0} />
              このページの{activeFilterDef.label}を全選択
            </label>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={selected.size === 0 || deleting}
              className="border border-red-400 text-red-500 rounded px-3 py-1 text-xs hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? '削除中...' : `選択した${selected.size}件を削除`}
            </button>
          </div>
        )}
        <div className={`grid ${selectionEnabled ? 'grid-cols-[32px_60px_1fr_100px_120px_100px_120px]' : 'grid-cols-[60px_1fr_100px_120px_100px_120px]'} gap-4 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500`}>
          {selectionEnabled && <span />}
          <span>画像</span>
          <span>商品名</span>
          <span>元価格</span>
          <span>eBay価格</span>
          <span>ステータス</span>
          <span>登録日</span>
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">
            {activeFilterDef.label === '総商品数' ? '在庫がありません' : `${activeFilterDef.label}の商品はありません`}
          </div>
        ) : (
          filtered.map((product) => (
            <div
              key={product.id}
              className={`grid ${selectionEnabled ? 'grid-cols-[32px_60px_1fr_100px_120px_100px_120px]' : 'grid-cols-[60px_1fr_100px_120px_100px_120px]'} gap-4 items-center px-4 py-3 border-b last:border-0 hover:bg-gray-50 text-sm`}
            >
              {selectionEnabled && (
                <input
                  type="checkbox"
                  checked={selected.has(product.id)}
                  onChange={() => toggleSelect(product.id)}
                />
              )}

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
                  product.listing_status === 'listing' ? 'bg-amber-100 text-amber-700' :
                  product.listing_status === 'listed' ? 'bg-blue-100 text-blue-700' :
                  product.listing_status === 'sold' ? 'bg-green-100 text-green-700' :
                  'bg-gray-100 text-gray-600'
                }`}>
                  {product.listing_status === 'draft' ? '下書き' :
                   product.listing_status === 'listing' ? '出品処理中' :
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
    </>
  )
}
