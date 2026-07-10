'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'
import type { SellerAccount, ListingCategory, BulkEditSetting } from '@/types/database'

interface Props {
  sellers: SellerAccount[]
  categories: ListingCategory[]
  bulkSettings: BulkEditSetting[]
  onSubmit: (data: {
    url: string
    categoryId: string
    sellerAccountId: string
    bulkEditSettingId: string
    isBulk: boolean
  }) => Promise<boolean | void>
}

export default function ExtractionForm({ sellers, categories, bulkSettings, onSubmit }: Props) {
  const [url, setUrl] = useState('')
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')
  const [sellerAccountId, setSellerAccountId] = useState(
    sellers.find((s) => s.is_default)?.id ?? sellers[0]?.id ?? ''
  )
  const [bulkEditSettingId, setBulkEditSettingId] = useState(bulkSettings[0]?.id ?? '')
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    if (!url.trim()) return
    setLoading(true)
    try {
      const result = await onSubmit({ url: url.trim(), categoryId, sellerAccountId, bulkEditSettingId, isBulk: true })
      if (result !== false) setUrl('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap mb-6">
      <input
        type="url"
        placeholder="抽出対象URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        className="border rounded px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-yellow-400"
      />

      {/* カテゴリ */}
      <div className="relative">
        <label className="absolute -top-2 left-2 text-[10px] text-gray-400 bg-white px-1">カテゴリ番号</label>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="border rounded px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.ebay_category_id})
            </option>
          ))}
        </select>
      </div>

      {/* 出品セラー */}
      <div className="relative">
        <label className="absolute -top-2 left-2 text-[10px] text-gray-400 bg-white px-1">出品セラー</label>
        <select
          value={sellerAccountId}
          onChange={(e) => setSellerAccountId(e.target.value)}
          className="border rounded px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          {sellers.map((s) => (
            <option key={s.id} value={s.id}>{s.seller_id}</option>
          ))}
        </select>
      </div>

      {/* 一括編集設定 */}
      <div className="relative">
        <label className="absolute -top-2 left-2 text-[10px] text-gray-400 bg-white px-1">一括編集設定</label>
        <select
          value={bulkEditSettingId}
          onChange={(e) => setBulkEditSettingId(e.target.value)}
          className="border rounded px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          {bulkSettings.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      <button
        className="border border-gray-300 rounded px-3 py-2 text-sm hover:bg-gray-50 transition-colors"
      >
        一括編集設定編集
      </button>

      <button
        onClick={handleSubmit}
        disabled={loading || !url.trim()}
        className="bg-[#1c1c1c] text-white rounded px-4 py-2 text-sm font-medium hover:bg-[#333] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? '抽出中...' : '抽出開始'}
      </button>
    </div>
  )
}
