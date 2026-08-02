'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { buildExtractionResultSummary } from '@/lib/extraction-activity'
import type { ExcludedProduct, Extraction, ExtractionActivity } from '@/types/database'

interface Props {
  extraction: Extraction
  onClose: () => void
  onOpenProducts: () => void
}

interface ActivityResponse {
  activities: ExtractionActivity[]
  excludedProducts: ExcludedProduct[]
  currentProductCount: number
}

export default function ExtractionResultModal({
  extraction,
  onClose,
  onOpenProducts,
}: Props) {
  const [data, setData] = useState<ActivityResponse>({
    activities: [],
    excludedProducts: [],
    currentProductCount: 0,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch(`/api/extractions/${extraction.id}/activity`, { cache: 'no-store' })
      .then(async (response) => {
        const json = await response.json()
        if (!response.ok) throw new Error(json.error ?? '抽出結果を取得できませんでした')
        if (active) {
          setData({
            activities: json.activities ?? [],
            excludedProducts: json.excludedProducts ?? [],
            currentProductCount: json.currentProductCount ?? 0,
          })
        }
      })
      .catch((caught) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : '抽出結果を取得できませんでした')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [extraction.id])

  const rows = useMemo(
    () => buildExtractionResultSummary(data.currentProductCount, data.excludedProducts),
    [data.currentProductCount, data.excludedProducts],
  )

  return (
    <div className="fixed inset-0 z-[130] bg-black/45 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="extraction-result-title"
        className="bg-white w-full max-w-2xl max-h-[92vh] rounded-xl shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b">
          <div>
            <h2 id="extraction-result-title" className="text-xl font-bold">抽出結果確認</h2>
            <p className="text-xs text-gray-500 mt-1">抽出ID: {extraction.id}</p>
          </div>
          <button
            type="button"
            aria-label="抽出結果を閉じる"
            onClick={onClose}
            className="p-2 text-gray-500 hover:text-gray-900"
          >
            <X size={22} />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          <a
            href="#result-summary"
            className="inline-block text-lg md:text-xl font-bold text-red-600 underline decoration-blue-600 underline-offset-4 mb-5"
          >
            ※抽出した商品が少ないと感じる方へ
          </a>

          {loading ? (
            <div className="py-16 text-center text-sm text-gray-400">抽出結果を読み込み中...</div>
          ) : error ? (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-4 py-3">
              {error}
            </div>
          ) : (
            <>
              <div id="result-summary" className="border rounded-lg divide-y">
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className={`grid grid-cols-[1fr_auto] gap-6 px-4 py-3 text-sm md:text-base ${
                      row.key === 'completed_count'
                        ? 'bg-blue-50 font-bold'
                        : row.key === 'excluded_total'
                          ? 'bg-red-50 font-bold'
                          : ''
                    }`}
                  >
                    <span>{row.label}</span>
                    <span className="tabular-nums min-w-16 text-right">
                      {row.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-3">
                除外詳細の保存機能追加前に削除された商品は、元データがないため集計に含まれません。
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3 px-6 py-4 border-t bg-gray-50 rounded-b-xl">
          <button
            type="button"
            onClick={onClose}
            className="border rounded px-5 py-2 text-sm hover:bg-white"
          >
            閉じる
          </button>
          <button
            type="button"
            onClick={onOpenProducts}
            disabled={extraction.status !== 'completed'}
            className="inline-flex items-center justify-center gap-2 border border-blue-500 text-blue-600 rounded px-5 py-2 text-sm hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            商品一覧を開く
            <ExternalLink size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
