'use client'

import { useMemo, useState } from 'react'
import type { Product } from '@/types/database'

export type ItemSpecifics = Record<string, string[]>
export type ItemSpecificsEditScope = 'page' | 'all'
export type ItemSpecificsEditMode = 'merge' | 'clear'

interface SpecificRow {
  id: number
  name: string
  value: string
}

interface Props {
  products: Product[]
  pagedIds: Set<string>
  getItemSpecifics: (product: Product) => ItemSpecifics
  onApply: (
    specifics: ItemSpecifics,
    mode: ItemSpecificsEditMode,
    scope: ItemSpecificsEditScope,
  ) => void
  onClose: () => void
}

export function parseSpecificValues(value: string): string[] {
  return [...new Set(
    value
      .split(/[,、\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  )]
}

export function mergeItemSpecifics(
  current: ItemSpecifics,
  updates: ItemSpecifics,
): ItemSpecifics {
  return { ...current, ...updates }
}

export default function ItemSpecificsEditModal({
  products,
  pagedIds,
  getItemSpecifics,
  onApply,
  onClose,
}: Props) {
  const [mode, setMode] = useState<ItemSpecificsEditMode>('merge')
  const [scope, setScope] = useState<ItemSpecificsEditScope>('page')
  const [rows, setRows] = useState<SpecificRow[]>([
    { id: 1, name: '', value: '' },
  ])
  const [nextId, setNextId] = useState(2)

  const targetProducts = scope === 'page'
    ? products.filter((product) => pagedIds.has(product.id))
    : products

  const specifics = useMemo<ItemSpecifics>(() => {
    const result: ItemSpecifics = {}
    for (const row of rows) {
      const name = row.name.trim()
      const values = parseSpecificValues(row.value)
      if (name && values.length > 0) result[name] = values
    }
    return result
  }, [rows])

  const hasDuplicateNames = rows
    .map((row) => row.name.trim().toLowerCase())
    .filter(Boolean)
    .some((name, index, names) => names.indexOf(name) !== index)
  const hasLongValue = rows.some((row) =>
    row.name.length > 65 || parseSpecificValues(row.value).some((value) => value.length > 65)
  )
  const canApply = targetProducts.length > 0
    && !hasDuplicateNames
    && !hasLongValue
    && (mode === 'clear' || Object.keys(specifics).length > 0)

  function updateRow(id: number, field: 'name' | 'value', value: string) {
    setRows((current) => current.map((row) => (
      row.id === id ? { ...row, [field]: value } : row
    )))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">アイテムスペシフィック一括編集</h2>
          <button
            type="button"
            aria-label="アイテムスペシフィック編集を閉じる"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          <div className="flex items-center gap-5">
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} />
              項目を追加・上書き
            </label>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={mode === 'clear'} onChange={() => setMode('clear')} />
              すべてクリア
            </label>
          </div>

          {mode === 'merge' && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                値を複数設定する場合はカンマで区切ってください。既存の別項目は保持されます。
              </p>
              {rows.map((row) => (
                <div key={row.id} className="grid grid-cols-[1fr_1.5fr_auto] gap-2 items-start">
                  <input
                    aria-label="項目名"
                    value={row.name}
                    maxLength={65}
                    onChange={(event) => updateRow(row.id, 'name', event.target.value)}
                    placeholder="例: Material"
                    className="border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                  />
                  <input
                    aria-label="項目値"
                    value={row.value}
                    onChange={(event) => updateRow(row.id, 'value', event.target.value)}
                    placeholder="例: Plastic, Metal"
                    className="border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                  />
                  <button
                    type="button"
                    disabled={rows.length === 1}
                    onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
                    className="border rounded px-3 py-2 text-sm text-gray-500 disabled:opacity-30"
                  >
                    削除
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={rows.length >= 50}
                onClick={() => {
                  setRows((current) => [...current, { id: nextId, name: '', value: '' }])
                  setNextId((current) => current + 1)
                }}
                className="border border-blue-400 text-blue-600 rounded px-3 py-1.5 text-xs disabled:opacity-40"
              >
                ＋ 項目を追加
              </button>
              {hasDuplicateNames && (
                <p className="text-xs text-red-500">同じ項目名を重複して設定できません</p>
              )}
              {hasLongValue && (
                <p className="text-xs text-red-500">項目名と各値は65文字以内にしてください</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">適用範囲:</span>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={scope === 'page'} onChange={() => setScope('page')} />
              現在のページ（{products.filter((product) => pagedIds.has(product.id)).length}件）
            </label>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
              抽出商品すべて（{products.length}件）
            </label>
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-2">プレビュー（対象 {targetProducts.length} 件）</p>
            <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
              {targetProducts.slice(0, 10).map((product) => {
                const after = mode === 'clear'
                  ? {}
                  : mergeItemSpecifics(getItemSpecifics(product), specifics)
                return (
                  <div key={product.id} className="text-xs flex gap-2">
                    <span className="text-gray-500 truncate max-w-52">{product.original_title}</span>
                    <span className="text-gray-400">→</span>
                    <span className="text-gray-800">
                      {Object.keys(after).length === 0 ? '未設定' : `${Object.keys(after).length}項目`}
                    </span>
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
          <button type="button" onClick={onClose} className="border rounded px-4 py-2 text-sm text-gray-600">
            キャンセル
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => {
              onApply(specifics, mode, scope)
              onClose()
            }}
            className="bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white rounded px-4 py-2 text-sm font-medium"
          >
            適用（{targetProducts.length}件）
          </button>
        </div>
      </div>
    </div>
  )
}
