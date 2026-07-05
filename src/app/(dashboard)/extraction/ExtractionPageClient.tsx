'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import ExtractionStats from '@/components/extraction/ExtractionStats'
import ExtractionForm from '@/components/extraction/ExtractionForm'
import ExtractionRow from '@/components/extraction/ExtractionRow'
import type { SellerAccount, ListingCategory, BulkEditSetting, Extraction } from '@/types/database'

interface Props {
  profile: { extraction_limit: number; extraction_used: number } | null
  sellers: SellerAccount[]
  categories: ListingCategory[]
  bulkSettings: BulkEditSetting[]
  extractions: Extraction[]
}

export default function ExtractionPageClient({
  profile,
  sellers,
  categories,
  bulkSettings,
  extractions: initialExtractions,
}: Props) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'bulk' | 'single'>('bulk')
  const [search, setSearch] = useState('')
  const [extractions, setExtractions] = useState(initialExtractions)
  const [error, setError] = useState('')
  const [, startTransition] = useTransition()

  const filtered = extractions.filter((e) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      e.id.toLowerCase().includes(q) ||
      e.source_url.toLowerCase().includes(q) ||
      (e.memo ?? '').toLowerCase().includes(q)
    )
  })

  async function handleExtract(data: {
    url: string
    categoryId: string
    sellerAccountId: string
    bulkEditSettingId: string
    isBulk: boolean
  }) {
    setError('')
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json.error ?? 'エラーが発生しました')
      return
    }
    // 抽出詳細ページへ即時遷移（進捗をリアルタイム表示）
    router.push(`/extraction/${json.extractionId}`)
  }

  return (
    <div className="p-6">
      {/* タブ */}
      <div className="flex gap-6 border-b mb-6">
        {[
          { key: 'bulk', label: '一括抽出/出品' },
          { key: 'single', label: 'シングル抽出' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key as 'bulk' | 'single')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === key
                ? 'border-gray-800 text-gray-800'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 統計 */}
      {profile && (
        <ExtractionStats
          limit={profile.extraction_limit}
          used={profile.extraction_used}
        />
      )}

      {/* 速度制限警告 */}
      <div className="mb-4 text-xs text-red-500 space-y-0.5">
        <p>現在抽出速度制限が適用されています。抽出完了までに最短で30分以上かかります</p>
        <p className="text-orange-500">
          「抽出管理強化パック」または「抽出速度アップ」のオプションをご利用いただくと、抽出速度を向上させることができます。
        </p>
      </div>

      {/* カテゴリ管理ボタン */}
      <button
        onClick={() => router.push('/categories')}
        className="border border-blue-400 text-blue-500 rounded px-4 py-1.5 text-sm hover:bg-blue-50 transition-colors mb-4"
      >
        出品カテゴリー管理
      </button>

      {/* 抽出フォーム */}
      {error && (
        <div className="mb-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}
      <ExtractionForm
        sellers={sellers}
        categories={categories}
        bulkSettings={bulkSettings}
        onSubmit={handleExtract}
      />

      {/* 検索 */}
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="検索(抽出id, メモ, url, カテゴリ, 編集者)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border rounded pl-9 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
        />
      </div>

      {/* 抽出リスト */}
      <div className="border rounded-md bg-white overflow-visible">
        {/* ヘッダー */}
        <div className="grid grid-cols-[160px_1fr_1fr_180px_140px_1fr] gap-4 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
          <span>種別</span>
          <span>抽出情報</span>
          <span>出品情報</span>
          <span>日時</span>
          <span>進捗</span>
          <span className="text-right">操作</span>
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">
            {search ? '検索結果がありません' : 'まだ抽出がありません。URLを入力して抽出を開始してください。'}
          </div>
        ) : (
          filtered.map((extraction) => (
            <ExtractionRow
              key={extraction.id}
              extraction={extraction}
              onViewResult={(id) => router.push(`/extraction/${id}`)}
              onDelete={(id) => setExtractions((prev) => prev.filter((e) => e.id !== id))}
            />
          ))
        )}
      </div>
    </div>
  )
}
