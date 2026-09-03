'use client'

import type { ExtractionExclusionSummary } from '@/types/database'

interface Props {
  summary: ExtractionExclusionSummary
  onClose: () => void
}

// 既存ツール(公式)の「抽出結果確認」に相当する除外詳細モーダル。
// 抽出パイプラインで実際に実行されている除外を表示する。「詳細取得の
// 2段階化」は、こちらのスクレイパーが検索結果1回のレスポンスで全項目を
// 取得済みのため実装を見送った(詳細ページへの追加アクセスが元々発生
// しておらず、常に0件にしかならない見せかけの項目になるため)。
const ROWS: { key: keyof ExtractionExclusionSummary; label: string }[] = [
  { key: 'detail_fetch_count', label: '詳細取得件数' },
  { key: 'sold_out_excluded', label: '売り切れ除外' },
  { key: 'no_image_excluded', label: '画像が1枚もない除外' },
  { key: 'no_price_excluded', label: '販売価格が取得できない除外' },
  { key: 'danger_word_excluded', label: '危険単語除外' },
  { key: 'vero_excluded', label: 'Vero除外' },
  { key: 'individual_danger_seller_excluded', label: '個別危険Seller除外' },
  { key: 'spot_word_excluded', label: 'スポット文字除外' },
  { key: 'low_rating_excluded', label: '評価数除外' },
  { key: 'slow_shipping_excluded', label: '発送日数除外' },
  { key: 'stale_excluded', label: '最終更新月除外' },
  { key: 'price_range_excluded', label: '価格範囲除外' },
  { key: 'translated_title_failed_excluded', label: 'タイトル翻訳失敗除外' },
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
