'use client'

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { ExternalLink, Search, X } from 'lucide-react'
import { summarizeExclusions } from '@/lib/extraction-activity'
import type { ExcludedProduct, Extraction, ExtractionActivity } from '@/types/database'

interface Props {
  extraction: Extraction
  onClose: () => void
}

interface ActivityResponse {
  activities: ExtractionActivity[]
  excludedProducts: ExcludedProduct[]
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function ExclusionDetailsModal({ extraction, onClose }: Props) {
  const [data, setData] = useState<ActivityResponse>({ activities: [], excludedProducts: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let active = true
    fetch(`/api/extractions/${extraction.id}/activity`, { cache: 'no-store' })
      .then(async (response) => {
        const json = await response.json()
        if (!response.ok) throw new Error(json.error ?? '除外履歴を取得できませんでした')
        if (active) setData(json)
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : '除外履歴を取得できませんでした')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [extraction.id])

  const summaries = useMemo(
    () => summarizeExclusions(data.excludedProducts),
    [data.excludedProducts],
  )
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return data.excludedProducts.filter((product) => {
      if (reason !== 'all' && product.reason_code !== reason) return false
      if (!query) return true
      return product.original_title.toLowerCase().includes(query)
        || product.source_url.toLowerCase().includes(query)
        || product.reason_label.toLowerCase().includes(query)
    })
  }, [data.excludedProducts, reason, search])

  return (
    <div className="fixed inset-0 z-[120] bg-black/45 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="exclusion-details-title"
        className="bg-white w-full max-w-6xl max-h-[92vh] rounded-xl shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b">
          <div>
            <h2 id="exclusion-details-title" className="text-xl font-bold">除外詳細</h2>
            <p className="text-xs text-gray-500 mt-1">
              抽出ID: {extraction.id} ／ 除外された商品の内容と理由
            </p>
          </div>
          <button aria-label="除外詳細を閉じる" onClick={onClose} className="p-2 text-gray-500 hover:text-gray-900">
            <X size={22} />
          </button>
        </div>

        <div className="overflow-y-auto p-6 space-y-5">
          {loading ? (
            <div className="py-16 text-center text-sm text-gray-400">除外履歴を読み込み中...</div>
          ) : error ? (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-4 py-3">
              {error}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-lg border bg-gray-50 px-4 py-3">
                  <p className="text-xs text-gray-500">除外商品合計</p>
                  <p className="text-2xl font-bold mt-1">{data.excludedProducts.length.toLocaleString()}件</p>
                </div>
                {summaries.slice(0, 3).map((summary) => (
                  <button
                    key={summary.reasonCode}
                    type="button"
                    onClick={() => setReason(summary.reasonCode)}
                    className="rounded-lg border px-4 py-3 text-left hover:border-blue-400 hover:bg-blue-50 transition-colors"
                  >
                    <p className="text-xs text-gray-500 truncate" title={summary.reasonLabel}>
                      {summary.reasonLabel}
                    </p>
                    <p className="text-2xl font-bold mt-1">{summary.count.toLocaleString()}件</p>
                  </button>
                ))}
              </div>

              <div className="flex flex-col md:flex-row gap-3">
                <select
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="border rounded px-3 py-2 text-sm min-w-52"
                >
                  <option value="all">すべての除外理由</option>
                  {summaries.map((summary) => (
                    <option key={summary.reasonCode} value={summary.reasonCode}>
                      {summary.reasonLabel}（{summary.count}件）
                    </option>
                  ))}
                </select>
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="商品名・URL・除外理由で検索"
                    className="w-full border rounded pl-9 pr-3 py-2 text-sm"
                  />
                </div>
              </div>

              {data.excludedProducts.length === 0 ? (
                <div className="border rounded-lg bg-gray-50 py-12 px-6 text-center">
                  <p className="text-sm text-gray-600">保存された除外商品はありません。</p>
                  <p className="text-xs text-gray-400 mt-2">
                    この機能の追加前に除外・削除された商品は、元データが残っていないため復元できません。
                    今後の除外はここへ記録されます。
                  </p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="border rounded-lg py-10 text-center text-sm text-gray-400">
                  条件に一致する除外商品がありません
                </div>
              ) : (
                <div className="border rounded-lg overflow-x-auto">
                  <div className="min-w-[800px]">
                    <div className="grid grid-cols-[72px_minmax(240px,1fr)_140px_110px_150px_48px] gap-3 px-4 py-2.5 bg-gray-50 border-b text-xs font-medium text-gray-500">
                      <span>画像</span>
                      <span>商品</span>
                      <span>除外理由</span>
                      <span>元価格</span>
                      <span>除外日時</span>
                      <span>URL</span>
                    </div>
                    <div className="divide-y max-h-[52vh] overflow-y-auto">
                      {filtered.map((product) => (
                        <div
                          key={product.id}
                          className="grid grid-cols-[72px_minmax(240px,1fr)_140px_110px_150px_48px] gap-3 items-center px-4 py-3 text-sm"
                        >
                          {product.image_url ? (
                            <Image
                              src={product.image_url}
                              alt=""
                              width={56}
                              height={56}
                              unoptimized
                              className="w-14 h-14 rounded border object-cover"
                            />
                          ) : (
                            <div className="w-14 h-14 rounded border bg-gray-50 flex items-center justify-center text-[10px] text-gray-400">
                              No image
                            </div>
                          )}
                        <div className="min-w-0">
                          <p className="font-medium truncate" title={product.original_title}>
                            {product.original_title}
                          </p>
                          <p className="text-xs text-gray-400 font-mono mt-1">
                            {product.product_id.slice(0, 12)}
                          </p>
                        </div>
                        <span className="inline-flex w-fit rounded-full bg-red-50 text-red-700 px-2 py-1 text-xs">
                          {product.reason_label}
                        </span>
                        <span>
                          {product.original_price == null
                            ? '—'
                            : `¥${Number(product.original_price).toLocaleString()}`}
                        </span>
                        <span className="text-xs text-gray-500">{formatDate(product.excluded_at)}</span>
                        <a
                          href={product.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${product.original_title}を開く`}
                          className="text-blue-600 hover:text-blue-800"
                        >
                          <ExternalLink size={17} />
                        </a>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end px-6 py-4 border-t bg-gray-50 rounded-b-xl">
          <button onClick={onClose} className="border rounded px-5 py-2 text-sm hover:bg-white">
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
