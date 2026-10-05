'use client'

import { useState } from 'react'
import { EBAY_CONDITION_OPTIONS, conditionTone } from '@/lib/listing-export'
import type { ConditionTone } from '@/lib/listing-export'

const CONDITIONS = ['新品', '新品同様', '良い', '普通', '中古', 'ジャンク'] as const

const TONE_BUTTON: Record<ConditionTone, string> = {
  new: 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100',
  likeNew: 'border-sky-300 bg-sky-50 text-sky-900 hover:bg-sky-100',
  used: 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100',
  poor: 'border-rose-300 bg-rose-50 text-rose-900 hover:bg-rose-100',
}

export interface ConditionEditValue {
  condition: string | null
  conditionId: string | null
}

interface Props {
  targetCount: { page: number; all: number }
  onApply: (value: ConditionEditValue, scope: 'page' | 'all') => void
  onClose: () => void
}

// ユーザー要望(2026-10-05): 商品状態だけでなく、eBayのConditionIDも一括で
// 指定したい(2750 / Like New、4000 / Very Good、5000 / Good など)。
// 2つを同時に指定すると「どちらが効くのか」が分からなくなるため、
// モードを選ばせて片方だけを設定する。
export default function ConditionEditModal({ targetCount, onApply, onClose }: Props) {
  const [mode, setMode] = useState<'condition' | 'conditionId'>('condition')
  const [condition, setCondition] = useState<string>('中古')
  const [conditionId, setConditionId] = useState<string>('3000')
  const scope: 'page' | 'all' = 'all'

  const value: ConditionEditValue = mode === 'condition'
    // ConditionIDの直接指定を解除して、商品状態からの自動判定に戻す
    ? { condition, conditionId: null }
    : { condition: null, conditionId }

  const appliedLabel = mode === 'condition'
    ? condition
    : (EBAY_CONDITION_OPTIONS.find((o) => o.id === conditionId)?.label ?? conditionId)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">商品状態一括編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5">
          <div className="flex gap-2">
            <button
              onClick={() => setMode('condition')}
              className={`flex-1 border rounded py-2 text-xs font-medium transition-colors ${
                mode === 'condition' ? 'bg-blue-500 text-white border-blue-500' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              商品状態で指定
            </button>
            <button
              onClick={() => setMode('conditionId')}
              className={`flex-1 border rounded py-2 text-xs font-medium transition-colors ${
                mode === 'conditionId' ? 'bg-blue-500 text-white border-blue-500' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              ConditionIDで直接指定
            </button>
          </div>

          {mode === 'condition' ? (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">
                適用する商品状態を選択（ConditionIDはカテゴリ設定から自動判定されます）
              </p>
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
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">
                eBayに送るConditionIDを直接指定します（商品状態やカテゴリ設定より優先されます）
              </p>
              {/* 11件あるので2列にして、スクロールせずに全部見えるようにする */}
              <div className="grid grid-cols-2 gap-1.5">
                {EBAY_CONDITION_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setConditionId(opt.id)}
                    className={`border rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      conditionId === opt.id
                        ? 'bg-blue-500 text-white border-blue-500'
                        : TONE_BUTTON[conditionTone(opt.id)]
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400">
                カテゴリによって使えるIDが異なります（例: CD・DVD等は 3000 / Used を受け付けません）。
              </p>
            </div>
          )}

          <div className="text-xs text-gray-500">
            適用範囲: 抽出商品すべて（{targetCount.all}件）
          </div>
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t">
          <button onClick={onClose}
            className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button
            onClick={() => { onApply(value, scope); onClose() }}
            className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-2 text-sm font-medium">
            「{appliedLabel}」を適用 ({targetCount.all}件)
          </button>
        </div>
      </div>
    </div>
  )
}
