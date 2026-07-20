'use client'

import { useState } from 'react'

const CONDITIONS = ['新品', '新品同様', '良い', '普通', '中古', 'ジャンク'] as const

interface Props {
  targetCount: { page: number; all: number }
  onApply: (condition: string, scope: 'page' | 'all') => void
  onClose: () => void
}

export default function ConditionEditModal({ targetCount, onApply, onClose }: Props) {
  const [condition, setCondition] = useState<string>('中古')
  const [scope, setScope] = useState<'page' | 'all'>('page')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">商品状態一括編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5">
          {/* 状態選択 */}
          <div className="space-y-2">
            <p className="text-xs text-gray-500">適用する商品状態を選択</p>
            <div className="grid grid-cols-3 gap-2">
              {CONDITIONS.map((c) => (
                <button
                  key={c}
                  onClick={() => setCondition(c)}
                  className={`border rounded py-2 text-sm font-medium transition-colors ${
                    condition === c
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* 適用範囲 */}
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">適用範囲:</span>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" value="page" checked={scope === 'page'} onChange={() => setScope('page')} />
              現在のページ（{targetCount.page}件）
            </label>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />
              すべて（{targetCount.all}件）
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t">
          <button onClick={onClose}
            className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button
            onClick={() => { onApply(condition, scope); onClose() }}
            className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 text-sm font-medium">
            「{condition}」を適用 ({scope === 'page' ? targetCount.page : targetCount.all}件)
          </button>
        </div>
      </div>
    </div>
  )
}
