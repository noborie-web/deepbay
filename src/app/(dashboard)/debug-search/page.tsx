'use client'
import { useState } from 'react'

export default function DebugSearchPage() {
  const [cookie, setCookie] = useState('')
  const [keyword, setKeyword] = useState('ダウンジャケット')
  const [minPrice, setMinPrice] = useState('5000')
  const [maxPrice, setMaxPrice] = useState('50000')
  const [apiResults, setApiResults] = useState<null | { results: Array<{ url: string; status: number; preview: string; itemCount?: number }> }>(null)
  const [htmlResult, setHtmlResult] = useState<null | Record<string, unknown>>(null)
  const [loading, setLoading] = useState(false)
  const [htmlLoading, setHtmlLoading] = useState(false)

  async function runApiTest() {
    setLoading(true)
    setApiResults(null)
    try {
      const res = await fetch('/api/snkr-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie, keyword, categoryIds: '2/38', minPrice, maxPrice }),
      })
      setApiResults(await res.json())
    } finally {
      setLoading(false)
    }
  }

  async function runHtmlTest() {
    setHtmlLoading(true)
    setHtmlResult(null)
    try {
      const searchUrl = encodeURIComponent(
        `https://snkrdunk.com/search?keywords=${encodeURIComponent(keyword)}&searchCategoryIds=2%2F38&minPrice=${minPrice}&maxPrice=${maxPrice}&isSaleOnly=true&page=1`
      )
      const cookieParam = cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''
      const res = await fetch(`/api/debug-fetch?url=${searchUrl}${cookieParam}`)
      setHtmlResult(await res.json())
    } finally {
      setHtmlLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Snkrdunk 認証テスト</h1>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">Cookie（snkrdunk.com の Request Headers からコピー）</label>
          <textarea
            className="w-full border rounded p-2 text-xs font-mono h-24"
            placeholder="_yjsu_yjad=...; session=..."
            value={cookie}
            onChange={e => setCookie(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">キーワード</label>
            <input className="w-full border rounded p-2" value={keyword} onChange={e => setKeyword(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">最低価格</label>
            <input className="w-full border rounded p-2" value={minPrice} onChange={e => setMinPrice(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">最高価格</label>
            <input className="w-full border rounded p-2" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={runApiTest} disabled={loading} className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'テスト中...' : '① v3/search APIテスト'}
          </button>
          <button onClick={runHtmlTest} disabled={htmlLoading} className="bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700 disabled:opacity-50">
            {htmlLoading ? '取得中...' : '② 検索ページHTML取得（認証つき）'}
          </button>
        </div>
      </div>

      {apiResults && (
        <div className="space-y-3">
          <h2 className="text-lg font-bold">① API結果</h2>
          {apiResults.results.map((r, i) => (
            <div key={i} className={`border rounded p-3 ${r.status === 200 ? 'border-green-400 bg-green-50' : 'border-gray-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`font-bold px-2 py-0.5 rounded text-sm ${r.status === 200 ? 'bg-green-500 text-white' : 'bg-gray-200'}`}>{r.status}</span>
                {r.itemCount !== undefined && <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-sm font-bold">{r.itemCount}件</span>}
                <code className="text-xs text-gray-600 truncate">{r.url}</code>
              </div>
              <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto whitespace-pre-wrap">{r.preview}</pre>
            </div>
          ))}
        </div>
      )}

      {htmlResult && (
        <div className="space-y-3">
          <h2 className="text-lg font-bold">② HTML取得結果</h2>
          <div className="border rounded p-3">
            <div className="grid grid-cols-2 gap-2 text-sm mb-3">
              <div>Status: <strong>{String(htmlResult.status)}</strong></div>
              <div>HTMLサイズ: <strong>{String(htmlResult.htmlLength)}文字</strong></div>
              <div>RSC pushCount: <strong>{String(htmlResult.rscPushCount)}</strong></div>
              <div>RSCデータサイズ: <strong>{String(htmlResult.rscCombinedLength)}文字</strong></div>
              <div>価格データ: <strong>{htmlResult.priceInRsc ? String(htmlResult.priceInRsc) : 'なし'}</strong></div>
              <div>商品ID: <strong>{htmlResult.knownListingId ? String(htmlResult.knownListingId) : 'なし'}</strong></div>
            </div>
            {Object.keys(htmlResult.foundKeysInRsc as Record<string, unknown>).length > 0 && (
              <div className="mb-3">
                <p className="font-bold text-green-700">見つかったキー: {Object.keys(htmlResult.foundKeysInRsc as Record<string, unknown>).join(', ')}</p>
                <pre className="text-xs bg-green-50 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(htmlResult.foundKeysInRsc, null, 2)}</pre>
              </div>
            )}
            {htmlResult.idContext && (
              <div className="mb-3">
                <p className="font-bold">商品IDのコンテキスト:</p>
                <pre className="text-xs bg-yellow-50 p-2 rounded mt-1 overflow-x-auto whitespace-pre-wrap">{String(htmlResult.idContext)}</pre>
              </div>
            )}
            <div>
              <p className="font-bold text-sm mb-1">RSCサンプル（先頭800文字）:</p>
              <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto whitespace-pre-wrap">{String(htmlResult.rscSample)}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
