'use client'

import { useState } from 'react'
import type { Product } from '@/types/database'

export type BrandEditScope = 'page' | 'all'
export type BrandEditMode = 'set' | 'clear'

interface Props {
  products: Product[]
  pagedIds: Set<string>
  getBrand: (product: Product) => string
  onApply: (brand: string | null, scope: BrandEditScope) => void
  onClose: () => void
}

export default function BrandEditModal({ products, pagedIds, getBrand, onApply, onClose }: Props) {
  const [mode, setMode] = useState<BrandEditMode>('set')
  const [brand, setBrand] = useState('')
  const [scope, setScope] = useState<BrandEditScope>('page')

  const trimmedBrand = brand.trim()
  const targetProducts = scope === 'page'
    ? products.filter((product) => pagedIds.has(product.id))
    : products
  const canApply = targetProducts.length > 0 && (mode === 'clear' || trimmedBrand.length > 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">ブランド一括編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          <div className="flex items-center gap-5">
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={mode === 'set'} onChange={() => setMode('set')} />
              同じブランドを設定
            </label>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={mode === 'clear'} onChange={() => setMode('clear')} />
              ブランドをクリア
            </label>
          </div>

          {mode === 'set' && (
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">ブランド名（最大65文字）</span>
              <div className="relative">
                <input
                  value={brand}
                  onChange={(event) => setBrand(event.target.value.slice(0, 65))}
                  maxLength={65}
                  placeholder="例: PILOT"
                  className="w-full border rounded px-3 py-2 pr-16 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                <span className="absolute right-3 bottom-2 text-xs text-gray-400">{brand.length} / 65</span>
              </div>
              {brand.length > 0 && trimmedBrand.length === 0 && (
                <p className="text-xs text-red-500">空白以外の文字を入力してください</p>
              )}
            </label>
          )}

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
            <p className="text-xs text-gray-500 mb-2">プレビュー（対象 {targetProducts.length} 件）</p>
            <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
              {targetProducts.slice(0, 10).map((product) => (
                <div key={product.id} className="text-xs flex gap-2">
                  <span className="text-gray-400 truncate max-w-40">{product.original_title}</span>
                  <span className="text-gray-400">:</span>
                  <span className="text-gray-400 line-through">{getBrand(product) || '未設定'}</span>
                  <span className="text-gray-400">→</span>
                  <span className="text-gray-800">{mode === 'clear' ? '未設定' : (trimmedBrand || '未入力')}</span>
                </div>
              ))}
              {targetProducts.length > 10 && (
                <p className="text-xs text-gray-400">…他 {targetProducts.length - 10} 件</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t">
          <button onClick={onClose} className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
            キャンセル
          </button>
          <button
            disabled={!canApply}
            onClick={() => {
              onApply(mode === 'clear' ? null : trimmedBrand, scope)
              onClose()
            }}
            className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium"
          >
            適用 ({targetProducts.length}件)
          </button>
        </div>
      </div>
    </div>
  )
}
