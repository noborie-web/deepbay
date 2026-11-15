'use client'

import type { ExtractionExclusionSummary } from '@/types/database'

interface Props {
  summary: ExtractionExclusionSummary
  onClose: () => void
}

// ai_time_limited は真偽値、amazon_*_asins は配列なので、件数の一覧には出さない。
type NumericSummaryKey = Exclude<
  keyof ExtractionExclusionSummary,
  'ai_time_limited'
  | 'amazon_no_new_offer_asins' | 'amazon_not_fba_asins'
  | 'amazon_pricing_failed_asins' | 'amazon_time_skipped_asins'
  // 危険単語の例外・内訳も配列なので、件数の一覧ではなく別枠で出す
  | 'danger_word_exceptions' | 'danger_word_hits'
>

// 本番で確認(2026-10-13): ASIN5件で抽出したら2件しか取り込まれず、残り3件が
// どの理由で落ちたか画面に何も出ていなかった。Amazonは抽出パイプラインに
// 入る前(SP-APIの取得段階)で落ちるものがあるので、別枠で表示する。
const AMAZON_ROWS: { key: NumericSummaryKey; label: string; hint?: string }[] = [
  { key: 'amazon_requested', label: '指定したASIN' },
  { key: 'amazon_no_new_offer', label: '新品の出品が無い' },
  { key: 'amazon_not_fba', label: 'FBAの出品が無い', hint: '「FBAのみ」を外すと対象になります' },
  { key: 'amazon_pricing_failed', label: '価格を取得できなかった', hint: '再実行で取得できることがあります' },
  { key: 'amazon_time_skipped', label: '時間切れで未処理', hint: '件数を減らして再実行してください' },
]

// 既存ツール(公式)の「抽出結果確認」に相当する除外詳細モーダル。
// 抽出パイプラインで実際に実行されている除外を表示する。評価数・発送
// 日数・最終更新月・価格範囲は、公式と同様に「グローバル抽出設定による
// 除外(無印)」と「一括編集設定プロファイルによる追加除外
// (「(一括編集)」接頭辞)」の2段階で集計する。
const ROWS: { key: NumericSummaryKey; label: string }[] = [
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
  { key: 'bulk_edit_sold_out_excluded', label: '(一括編集)売り切れ除外' },
  { key: 'bulk_edit_danger_seller_excluded', label: '(一括編集)危険Seller除外' },
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
          {summary.amazon_requested !== undefined && (
            <div className="rounded border bg-amber-50 border-amber-200 p-3">
              <p className="text-xs font-medium text-amber-900">Amazonからの取り込み</p>
              <p className="pt-0.5 text-[11px] text-amber-800">
                ここで落ちた商品は、以下の除外項目には含まれません（抽出に入る前の段階です）。
              </p>
              <div className="pt-2 space-y-1.5">
                {AMAZON_ROWS.map(({ key, label, hint }) => (
                  <div key={key} className="flex items-start justify-between gap-3">
                    <span className="text-xs text-amber-900">
                      {label}
                      {hint && (summary[key] ?? 0) > 0 && (
                        <span className="block text-[11px] text-amber-700">{hint}</span>
                      )}
                    </span>
                    <span className="text-xs font-medium text-amber-900">
                      {(summary[key] ?? 0).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {summary.ai_time_limited && (
            <p className="rounded bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              実行時間の上限が近づいたため、一部の商品はAI処理(タイトル翻訳・説明文・ブランド)を省略して保存しました。
              商品は下書きとして残っているので、件数を減らして再抽出するか、下書きを個別に編集してください。
            </p>
          )}
          {/* ユーザー要望(2026-11-15): 今回だけ除外しなかった危険単語を出す。
              「なぜ通ったのか」が後から分かるようにする。 */}
          {(summary.danger_word_exceptions ?? []).length > 0 && (
            <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              この抽出では次の危険単語を除外しませんでした:{' '}
              <span className="font-medium">{(summary.danger_word_exceptions ?? []).join(' / ')}</span>
            </div>
          )}
          {/* ユーザー要望(2026-11-15): カメラの抽出で190件中132件が危険単語で
              落ちたが、どの単語に当たったか分からなかった。一覧は4,164語あり、
              誤登録(g / _ など1文字)と正しい除外が混ざっている。 */}
          {(summary.danger_word_hits ?? []).length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <p className="font-medium">危険単語の内訳（多い順）</p>
              <ul className="mt-1 space-y-0.5">
                {(summary.danger_word_hits ?? []).map((hit) => {
                  // 「word:件数」。単語自体にコロンが入ることがあるので末尾で切る
                  const at = hit.lastIndexOf(':')
                  const word = at >= 0 ? hit.slice(0, at) : hit
                  const count = at >= 0 ? hit.slice(at + 1) : ''
                  return (
                    <li key={hit} className="flex items-center justify-between gap-2">
                      <span className="font-mono break-all">{word}</span>
                      <span>{count}件</span>
                    </li>
                  )
                })}
              </ul>
              <p className="mt-1 text-amber-700">
                意図しない語があれば、抽出時の「危険単語の例外」に入れるか、一覧から削除してください。
              </p>
            </div>
          )}
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
