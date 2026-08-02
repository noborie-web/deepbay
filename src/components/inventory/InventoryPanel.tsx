'use client'

import { useState, useRef } from 'react'
import type { InventoryActiveListing } from '@/types/database'

interface Props {
  listings: InventoryActiveListing[]
  hasToken: boolean
}

export default function InventoryPanel({ listings: initialListings, hasToken }: Props) {
  const [listings, setListings] = useState<InventoryActiveListing[]>(initialListings)
  const [syncing, setSyncing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 5000)
  }

  const handleSync = async () => {
    setSyncing(true)
    setMessage(null)
    try {
      const res = await fetch('/api/inventory/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Sync failed')
      showMsg('success', `同期完了: ${json.total}件取得、${json.matched}件マッチ`)
      // Reload listings
      const listRes = await fetch('/api/inventory/listings')
      if (listRes.ok) {
        const data = await listRes.json()
        setListings(data.listings ?? [])
      }
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '同期に失敗しました')
    } finally {
      setSyncing(false)
    }
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setMessage(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/inventory/upload', { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Upload failed')
      showMsg('success', `アップロード完了: ${json.total}件取得、${json.matched}件マッチ`)
      // Reload listings
      const listRes = await fetch('/api/inventory/listings')
      if (listRes.ok) {
        const data = await listRes.json()
        setListings(data.listings ?? [])
      }
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : 'アップロードに失敗しました')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="mt-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-800">eBay出品管理</h2>
          <p className="text-xs text-amber-600 font-medium mt-0.5">
            現在は監視モードです。eBay商品の自動取り下げは実行しません。
          </p>
        </div>
        <div className="flex gap-2">
          {/* CSV Upload */}
          <label className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border cursor-pointer ${
            uploading ? 'opacity-50 pointer-events-none' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
          }`}>
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              ref={fileRef}
              onChange={handleUpload}
              disabled={uploading}
            />
            {uploading ? 'アップロード中...' : 'CSVアップロード'}
          </label>

          {/* eBay Sync */}
          <button
            onClick={handleSync}
            disabled={syncing || !hasToken}
            title={!hasToken ? 'eBayトークンを設定してください' : undefined}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium ${
              syncing || !hasToken
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {syncing ? '同期中...' : 'eBay同期'}
          </button>
        </div>
      </div>

      {/* Message */}
      {message && (
        <div className={`mb-3 px-4 py-2 rounded text-sm ${
          message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}

      {/* Listings Table */}
      <div className="bg-white border rounded-md overflow-hidden">
        <div className="grid grid-cols-[1fr_100px_60px_80px_100px] gap-4 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
          <span>商品名</span>
          <span>現在価格</span>
          <span>数量</span>
          <span>ステータス</span>
          <span>取得日時</span>
        </div>

        {listings.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">
            出品データがありません。eBay同期またはCSVアップロードを実行してください。
          </div>
        ) : (
          listings.map((listing) => (
            <div
              key={listing.id}
              className="grid grid-cols-[1fr_100px_60px_80px_100px] gap-4 items-center px-4 py-3 border-b last:border-0 hover:bg-gray-50 text-sm"
            >
              <div>
                <p className="font-medium text-gray-800 truncate">{listing.title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-gray-400">#{listing.ebay_item_id}</p>
                  {listing.product_id && (
                    <span className="text-xs text-green-600 font-medium">● 商品マッチ</span>
                  )}
                  {listing.source_url && (
                    <span className="text-xs text-blue-500 truncate max-w-[200px]">{listing.source_url}</span>
                  )}
                </div>
              </div>
              <div className="text-gray-700 font-medium">
                {listing.current_price != null ? `$${listing.current_price.toFixed(2)}` : '—'}
              </div>
              <div className="text-gray-600 text-center">{listing.quantity ?? '—'}</div>
              <div>
                <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                  listing.listing_status === 'Active' ? 'bg-blue-100 text-blue-700' :
                  listing.listing_status === 'Ended' ? 'bg-gray-100 text-gray-500' :
                  'bg-yellow-100 text-yellow-700'
                }`}>
                  {listing.listing_status ?? '不明'}
                </span>
              </div>
              <div className="text-xs text-gray-400">
                {new Date(listing.fetched_at).toLocaleDateString('ja-JP')}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
