'use client'

import { useState } from 'react'
import { ExternalLink, KeyRound, Search } from 'lucide-react'

interface RestoreResult {
  dbkId: string
  sourceUrl: string
  sourceSite: string
  title: string
  productId: string | null
  createdAt: string
}

export default function SourceUrlRestore() {
  const [dbkId, setDbkId] = useState('')
  const [result, setResult] = useState<RestoreResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function restore() {
    if (!dbkId.trim()) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/inventory/restore-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbkId }),
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? '復元できませんでした')
      setResult(json.result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '復元できませんでした')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="bg-white border rounded-lg mb-6 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b bg-gray-50">
        <KeyRound size={20} className="text-blue-600" />
        <div>
          <h2 className="font-semibold text-gray-800">仕入れ先URL復元</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            eBayのCustomLabelに入っているDBK-IDから、元の商品ページを確認します。
          </p>
        </div>
      </div>

      <div className="p-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            value={dbkId}
            onChange={(event) => setDbkId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void restore()
            }}
            placeholder="例: ele_20260727_A1B2C3D4E5F6G7H8"
            aria-label="DBK-ID"
            className="flex-1 border rounded px-3 py-2.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            type="button"
            onClick={() => void restore()}
            disabled={loading || !dbkId.trim()}
            className="inline-flex items-center justify-center gap-2 rounded bg-blue-600 text-white px-5 py-2.5 text-sm hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Search size={16} />
            {loading ? '復元中...' : '復元'}
          </button>
        </div>

        {error && (
          <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-4 py-3">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-4 border border-blue-200 bg-blue-50 rounded-lg p-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs text-blue-600 font-mono">{result.dbkId}</p>
                <p className="font-medium text-gray-900 mt-1">{result.title}</p>
                <p className="text-xs text-gray-500 mt-1">{result.sourceSite}</p>
                <p className="text-sm text-gray-700 break-all mt-2">{result.sourceUrl}</p>
              </div>
              <a
                href={result.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 inline-flex items-center justify-center gap-2 border border-blue-500 text-blue-600 rounded px-4 py-2 text-sm hover:bg-white"
              >
                仕入れ先を開く
                <ExternalLink size={15} />
              </a>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
