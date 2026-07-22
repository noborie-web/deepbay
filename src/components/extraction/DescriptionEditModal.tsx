'use client'

import { useState } from 'react'
import type { Product } from '@/types/database'

export type DescriptionEditScope = 'page' | 'all'
export type DescriptionEditMode = 'set' | 'add' | 'replace' | 'clear'

export interface DescriptionEditOp {
  mode: DescriptionEditMode
  value?: string
  prefix?: string
  suffix?: string
  searchStr?: string
  replaceStr?: string
}

interface Props {
  products: Product[]
  pagedIds: Set<string>
  getDescription: (product: Product) => string
  onApply: (op: DescriptionEditOp, scope: DescriptionEditScope) => void
  onClose: () => void
}

export const DESCRIPTION_MAX_LENGTH = 500_000

export function applyDescriptionOp(description: string, op: DescriptionEditOp): string | null {
  if (op.mode === 'clear') return null
  if (op.mode === 'set') return (op.value ?? '').slice(0, DESCRIPTION_MAX_LENGTH)
  if (op.mode === 'replace') {
    if (!op.searchStr) return description
    return description.split(op.searchStr).join(op.replaceStr ?? '').slice(0, DESCRIPTION_MAX_LENGTH)
  }
  return `${op.prefix ?? ''}${description}${op.suffix ?? ''}`.slice(0, DESCRIPTION_MAX_LENGTH)
}

export default function DescriptionEditModal({ products, pagedIds, getDescription, onApply, onClose }: Props) {
  const [mode, setMode] = useState<DescriptionEditMode>('set')
  const [value, setValue] = useState('')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [searchStr, setSearchStr] = useState('')
  const [replaceStr, setReplaceStr] = useState('')
  const [scope, setScope] = useState<DescriptionEditScope>('page')

  const targetProducts = scope === 'page'
    ? products.filter((product) => pagedIds.has(product.id))
    : products
  const op: DescriptionEditOp = { mode, value, prefix, suffix, searchStr, replaceStr }
  const canApply = targetProducts.length > 0 && (
    mode === 'clear'
    || (mode === 'set' && value.trim().length > 0)
    || (mode === 'add' && (prefix.length > 0 || suffix.length > 0))
    || (mode === 'replace' && searchStr.length > 0)
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">商品詳細一括編集</h2>
          <button aria-label="商品詳細一括編集を閉じる" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          <div className="flex flex-wrap items-center gap-5">
            {([
              ['set', '同じ商品詳細を設定'],
              ['add', '先頭・末尾に追加'],
              ['replace', '検索・置換'],
              ['clear', '商品詳細をクリア'],
            ] as const).map(([option, label]) => (
              <label key={option} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="radio" checked={mode === option} onChange={() => setMode(option)} />
                {label}
              </label>
            ))}
          </div>

          {mode === 'set' && (
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">商品詳細</span>
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value.slice(0, DESCRIPTION_MAX_LENGTH))}
                maxLength={DESCRIPTION_MAX_LENGTH}
                rows={8}
                placeholder="商品詳細を入力"
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y"
              />
              <p className="text-right text-xs text-gray-400">{value.length.toLocaleString()} / {DESCRIPTION_MAX_LENGTH.toLocaleString()}</p>
              {value.length > 0 && value.trim().length === 0 && (
                <p className="text-xs text-red-500">空白以外の文字を入力してください</p>
              )}
            </label>
          )}

          {mode === 'add' && (
            <div className="grid grid-cols-2 gap-4">
              <label className="block space-y-1">
                <span className="text-xs text-gray-500">先頭に追加</span>
                <textarea value={prefix} onChange={(event) => setPrefix(event.target.value)} rows={4}
                  placeholder="商品詳細の先頭に追加" className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y" />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-gray-500">末尾に追加</span>
                <textarea value={suffix} onChange={(event) => setSuffix(event.target.value)} rows={4}
                  placeholder="商品詳細の末尾に追加" className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y" />
              </label>
            </div>
          )}

          {mode === 'replace' && (
            <div className="grid grid-cols-2 gap-4">
              <label className="block space-y-1">
                <span className="text-xs text-gray-500">検索</span>
                <textarea value={searchStr} onChange={(event) => setSearchStr(event.target.value)} rows={4}
                  placeholder="置換前の文字列" className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y" />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-gray-500">置換後</span>
                <textarea value={replaceStr} onChange={(event) => setReplaceStr(event.target.value)} rows={4}
                  placeholder="空欄で削除" className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300 resize-y" />
              </label>
            </div>
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
            <div className="space-y-2 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
              {targetProducts.slice(0, 5).map((product) => {
                const after = applyDescriptionOp(getDescription(product), op)
                return (
                  <div key={product.id} className="text-xs">
                    <p className="text-gray-400 truncate">{product.original_title}</p>
                    <p className="text-gray-800 whitespace-pre-wrap break-words line-clamp-3">{after || '未設定'}</p>
                  </div>
                )
              })}
              {targetProducts.length > 5 && <p className="text-xs text-gray-400">…他 {targetProducts.length - 5} 件</p>}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t">
          <button onClick={onClose} className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button disabled={!canApply} onClick={() => { onApply(op, scope); onClose() }}
            className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium">
            適用 ({targetProducts.length}件)
          </button>
        </div>
      </div>
    </div>
  )
}
