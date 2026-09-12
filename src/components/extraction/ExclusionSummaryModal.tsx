'use client'

import type { ExtractionExclusionSummary } from '@/types/database'

interface Props {
  summary: ExtractionExclusionSummary
  onClose: () => void
}

// 既存ツール(公式)の「抽出結果確認」に相当する除外詳細モーダル。
// 抽出パイプラインで実際に実行されている除外を表示する。評価数・発送
// 日数・最終更新月・価格範囲は、公式と同様に「グローバル抽出設定による
// 除外(無印)」と「一括編集設定プロファイルによる追加除外
// (「(一括編集)」接頭辞)」の2段階で集計する。
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
  { key: 'bulk_edit_rating_excluded', label: '(一括編集)評価数除外' },
  { key: 'bulk_edit_bad_rating_excluded', label: '(一括編集)低評価数除外' },
  { key: 'bulk_edit_shipping_days_excluded', label: '(一括編集)発送日数除外' },
  { key: 'bulk_edit_updated_months_excluded', label: '(一括編集)最終更新月除外' },
  { key: 'bulk_edit_price_range_excluded', label: '(一括編集)価格範囲除外' },
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
              {/* 新しい集計項目追加前に保存された古いexclusion_summaryには
                  キーが存在しない場合があるため、未定義は0として表示する */}
              <span className="font-medium text-gray-900">{(summary[key] ?? 0).toLocaleString()}</span>
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
