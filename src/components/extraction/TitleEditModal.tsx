'use client'

import { useState } from 'react'
import type { Product } from '@/types/database'

export type TitleEditScope = 'page' | 'all'

export interface TitleEditOp {
  prefix?: string
  suffix?: string
  searchStr?: string
  replaceStr?: string
}

interface Props {
  products: Product[]
  pagedIds: Set<string>
  getTitle: (p: Product) => string
  onApply: (op: TitleEditOp, scope: TitleEditScope) => void
  onClose: () => void
}

/** タイトルに操作を適用し、常に80文字以内に切り詰める */
function applyOp(title: string, op: TitleEditOp): string {
  let t = title
  if (op.searchStr) t = t.split(op.searchStr).join(op.replaceStr ?? '')
  if (op.prefix) t = op.prefix + t
  if (op.suffix) t = t + op.suffix
  return t.slice(0, 80)
}

export default function TitleEditModal({ products, pagedIds, getTitle, onApply, onClose }: Props) {
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [searchStr, setSearchStr] = useState('')
  const [replaceStr, setReplaceStr] = useState('')
  const [scope, setScope] = useState<TitleEditScope>('page')

  const op: TitleEditOp = {
    prefix: prefix || undefined,
    suffix: suffix || undefined,
    searchStr: searchStr || undefined,
    replaceStr: searchStr ? replaceStr : undefined,
  }

  const targetProducts = scope === 'page'
    ? products.filter((p) => pagedIds.has(p.id))
    : products
  const previewCount = targetProducts.length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">タイトル一括編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <p className="text-xs text-gray-400">タイトルは常に80文字以内に切り詰めます</p>

          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">先頭に追加</span>
              <input value={prefix} onChange={(e) => setPrefix(e.target.value)}
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                placeholder="例: [US] " />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">末尾に追加</span>
              <input value={suffix} onChange={(e) => setSuffix(e.target.value)}
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                placeholder="例:  from Japan" />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">検索</span>
              <input value={searchStr} onChange={(e) => setSearchStr(e.target.value)}
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                placeholder="置換前の文字列" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">置換後</span>
              <input value={replaceStr} onChange={(e) => setReplaceStr(e.target.value)}
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                placeholder="空白で削除" />
            </label>
          </div>

          {/* 適用範囲 */}
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">適用範囲:</span>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" value="page" checked={scope === 'page'} onChange={() => setScope('page')} />
              現在のページ
            </label>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />
              抽出商品すべて
            </label>
          </div>

          {/* プレビュー */}
          <div>
            <p className="text-xs text-gray-500 mb-2">プレビュー（対象 {previewCount} 件 / 全て80文字以内に切り詰め）</p>
            <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
              {targetProducts.slice(0, 10).map((p) => {
                const before = getTitle(p)
                const after = applyOp(before, op)
                return (
                  <div key={p.id} className="text-xs">
                    <span className="text-gray-400 line-through">{before.slice(0, 60)}{before.length > 60 ? '…' : ''}</span>
                    <span className="mx-1 text-gray-400">→</span>
                    <span className="text-gray-800">{after}</span>
                    <span className="ml-1 text-gray-400">({after.length}文字)</span>
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
          <button onClick={onClose}
            className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button
            onClick={() => { onApply(op, scope); onClose() }}
            className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 text-sm font-medium">
            適用 ({previewCount}件)
          </button>
        </div>
      </div>
    </div>
  )
}

export { applyOp }
