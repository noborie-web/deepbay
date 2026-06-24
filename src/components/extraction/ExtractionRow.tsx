'use client'

import { Copy, Pencil, MoreHorizontal } from 'lucide-react'
import Badge from '@/components/ui/Badge'
import type { Extraction } from '@/types/database'

interface Props {
  extraction: Extraction
  onViewResult: (id: string) => void
}

const STATUS_BADGE: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  pending:    { label: '待機中', variant: 'default' },
  processing: { label: '抽出中', variant: 'info' },
  completed:  { label: '完了', variant: 'success' },
  failed:     { label: '失敗', variant: 'error' },
}

export default function ExtractionRow({ extraction, onViewResult }: Props) {
  const status = STATUS_BADGE[extraction.status] ?? STATUS_BADGE.pending
  const isManual = !extraction.is_bulk

  function copyId() {
    navigator.clipboard.writeText(extraction.id)
  }

  return (
    <div className="grid grid-cols-[160px_1fr_1fr_180px_140px_1fr] gap-4 items-center px-4 py-3 border-b last:border-0 hover:bg-gray-50 text-sm">
      {/* 種別 */}
      <div>
        <Badge variant="default">
          {isManual ? '手動' : '自動'}/一括/通常
        </Badge>
      </div>

      {/* 抽出ID・セラー・カテゴリ */}
      <div className="space-y-0.5 text-xs text-gray-600">
        <div className="flex items-center gap-1">
          <span className="text-gray-400">抽出ID:</span>
          <span className="font-mono">{extraction.id.slice(0, 10)}...</span>
          <button onClick={copyId} className="hover:text-gray-900 transition-colors">
            <Copy size={11} />
          </button>
        </div>
        <div><span className="text-gray-400">セラーID:</span> {extraction.seller_account?.seller_id ?? '—'}</div>
        <div><span className="text-gray-400">出品カテゴリNo.</span> {extraction.category?.ebay_category_id ?? '—'}</div>
      </div>

      {/* 抽出サイト・メモ */}
      <div className="space-y-0.5 text-xs text-gray-600">
        <div>
          <span className="text-gray-400">一括編集設定: </span>
          {extraction.bulk_edit_setting?.name ?? '1'}...
        </div>
        <div>
          <span className="text-gray-400">抽出サイト: </span>
          <a href={extraction.source_url} target="_blank" rel="noopener noreferrer"
            className="text-blue-500 hover:underline truncate max-w-[140px] inline-block align-bottom">
            {new URL(extraction.source_url).hostname}
          </a>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400">抽出リスト名:</span>
          <button className="hover:text-gray-900"><Pencil size={11} /></button>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-gray-400">メモ:</span>
          <button className="hover:text-gray-900"><Pencil size={11} /></button>
        </div>
      </div>

      {/* 日時 */}
      <div className="space-y-0.5 text-xs text-gray-600">
        <div>
          <span className="text-gray-400">抽出: </span>
          {extraction.extracted_at
            ? new Date(extraction.extracted_at).toLocaleDateString('ja-JP')
            : new Date(extraction.created_at).toLocaleDateString('ja-JP')}
        </div>
        <div><span className="text-gray-400">編集: </span></div>
        <div><span className="text-gray-400">出品: </span></div>
      </div>

      {/* 進捗バー */}
      <div className="flex items-center gap-2">
        <div className="flex-1 bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all"
            style={{ width: `${extraction.progress}%` }}
          />
        </div>
        <span className="text-xs text-gray-500 w-8">{extraction.progress}%</span>
      </div>

      {/* アクション */}
      <div className="flex items-center gap-2 justify-end">
        <button
          disabled
          className="border rounded px-2.5 py-1 text-xs text-gray-400 cursor-not-allowed"
        >
          商品編集
        </button>
        <button
          disabled
          className="border rounded px-2.5 py-1 text-xs text-gray-400 cursor-not-allowed"
        >
          出品
        </button>
        <button
          onClick={() => onViewResult(extraction.id)}
          className="border border-blue-300 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50 transition-colors"
        >
          抽出結果確認
        </button>
        <button className="text-gray-400 hover:text-gray-700 transition-colors">
          <MoreHorizontal size={16} />
        </button>
      </div>
    </div>
  )
}
