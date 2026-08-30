'use client'

import type { ExtractionExclusionSummary } from '@/types/database'

interface Props {
  summary: ExtractionExclusionSummary
  onClose: () => void
}

// 既存ツール(公式)の「抽出結果確認」に相当する除外詳細モーダル。
// 第一段階として、抽出パイプラインで実際に実行されている除外
// (詳細取得件数・危険単語・active重複・タイトル重複・翻訳後タイトル重複・
// 取得完了件数)のみを表示する。一括編集設定の除外条件(発送日数・評価数等)
// を抽出時に自動適用する機能は未実装のため、この内訳には含まれない。
const ROWS: { key: keyof ExtractionExclusionSummary; label: string }[] = [
  { key: 'detail_fetch_count', label: '詳細取得件数' },
  { key: 'danger_word_excluded', label: '危険単語除外' },
  { key: 'active_duplicate_excluded', label: 'active重複除外' },
  { key: 'title_duplicate_excluded', label: 'タイトル重複除外' },
  { key: 'translated_duplicate_excluded', label: '翻訳後タイトル重複除外' },
  { key: 'completed_count', label: '取得完了件数' },
]

export default function ExclusionSummaryModal({ summary, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b">
          <h2 className="font-bold text-gray-900">除外詳細</h2>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3 text-sm">
          {ROWS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-gray-700">{label}</span>
              <span className="font-medium text-gray-900">{summary[key].toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div className="px-5 py-4 border-t flex justify-center">
          <button
            onClick={onClose}
            className="border rounded px-6 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            とじる
          </button>
        </div>
      </div>
    </div>
  )
}
