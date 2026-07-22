'use client'

import { useState } from 'react'
import type { Product } from '@/types/database'

export type ImageCountEditScope = 'page' | 'all'

interface Props {
  products: Product[]
  pagedIds: Set<string>
  getImages: (product: Product) => string[]
  onApply: (keepCount: number, scope: ImageCountEditScope) => void
  onClose: () => void
}

export const EBAY_IMAGE_MAX_COUNT = 12

export function limitImages(images: string[], keepCount: number): string[] {
  const safeCount = Math.min(EBAY_IMAGE_MAX_COUNT, Math.max(1, Math.trunc(keepCount)))
  return images.slice(0, safeCount)
}

export default function ImageCountEditModal({ products, pagedIds, getImages, onApply, onClose }: Props) {
  const [keepCount, setKeepCount] = useState('12')
  const [scope, setScope] = useState<ImageCountEditScope>('page')

  const parsedCount = Number(keepCount)
  const isValidCount = Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= EBAY_IMAGE_MAX_COUNT
  const targetProducts = scope === 'page'
    ? products.filter((product) => pagedIds.has(product.id))
    : products
  const changedCount = isValidCount
    ? targetProducts.filter((product) => getImages(product).length > parsedCount).length
    : 0
  const canApply = targetProducts.length > 0 && isValidCount && changedCount > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">画像枚数一括編集</h2>
          <button aria-label="画像枚数一括編集を閉じる" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          <label className="block space-y-1">
            <span className="text-xs text-gray-500">残す画像枚数（先頭から1〜{EBAY_IMAGE_MAX_COUNT}枚）</span>
            <input
              aria-label="残す画像枚数"
              type="number"
              min={1}
              max={EBAY_IMAGE_MAX_COUNT}
              step={1}
              value={keepCount}
              onChange={(event) => setKeepCount(event.target.value)}
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
            {!isValidCount && (
              <p className="text-xs text-red-500">1〜{EBAY_IMAGE_MAX_COUNT}の整数を入力してください</p>
            )}
            <p className="text-xs text-gray-500">指定枚数を超えるeBay出品用画像を末尾から除外します。元画像は変更しません。</p>
          </label>

          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">適用範囲:</span>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={scope === 'page'} onChange={() => setScope('page')} />
              現在のページ
            </label>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
              抽出商品すべて
            </label>
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-2">
              プレビュー（対象 {targetProducts.length} 件 / 変更 {changedCount} 件）
            </p>
            <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
              {targetProducts.slice(0, 10).map((product) => {
                const before = getImages(product).length
                const after = isValidCount ? limitImages(getImages(product), parsedCount).length : before
                return (
                  <div key={product.id} className="text-xs flex gap-2">
                    <span className="text-gray-400 truncate flex-1">{product.original_title}</span>
                    <span className={before !== after ? 'text-blue-600' : 'text-gray-500'}>{before}枚 → {after}枚</span>
                  </div>
                )
              })}
              {targetProducts.length > 10 && (
                <p className="text-xs text-gray-400">…他 {targetProducts.length - 10} 件</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t">
          <button onClick={onClose} className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button
            disabled={!canApply}
            onClick={() => {
              onApply(parsedCount, scope)
              onClose()
            }}
            className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium"
          >
            適用（変更 {changedCount}件）
          </button>
        </div>
      </div>
    </div>
  )
}
