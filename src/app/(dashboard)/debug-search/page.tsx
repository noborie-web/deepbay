'use client'
import { useState } from 'react'

export default function DebugSearchPage() {
  const [token, setToken] = useState('')
  const [cookie, setCookie] = useState('')
  const [keyword, setKeyword] = useState('ダウンジャケット')
  const [minPrice, setMinPrice] = useState('5000')
  const [maxPrice, setMaxPrice] = useState('50000')
  const [results, setResults] = useState<null | { results: Array<{ url: string; status: number; preview: string; itemCount?: number }> }>(null)
  const [loading, setLoading] = useState(false)

  async function runTest() {
    setLoading(true)
    setResults(null)
    try {
      const res = await fetch('/api/snkr-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, cookie, keyword, categoryIds: '2/38', minPrice, maxPrice }),
      })
      setResults(await res.json())
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">Snkrdunk 認証テスト</h1>

      <div className="bg-blue-50 border border-blue-200 rounded p-4 text-sm space-y-2">
        <p className="font-bold">手順: snkrdunk.com の DevTools → Network タブから認証情報を取得</p>
        <ol className="list-decimal ml-4 space-y-1">
          <li>snkrdunk.com を開いてログイン済みであることを確認</li>
          <li>DevTools → Network タブを開く（F12）</li>
          <li>「me」または「filter」リクエストをクリック</li>
          <li>Headers タブ → Request Headers セクションを確認</li>
          <li><strong>Authorization</strong> ヘッダーの値をコピー（例: <code>Bearer eyJ...</code>）</li>
          <li>下の「Authorization トークン」欄に貼り付け</li>
        </ol>
        <p className="text-gray-600">または: リクエストを右クリック → Copy → Copy as cURL → テキストエディタに貼り付けて <code>-H &apos;authorization: Bearer eyJ...&apos;</code> の部分をコピー</p>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">Authorization トークン（Bearer eyJ... の形式）</label>
          <textarea
            className="w-full border rounded p-2 text-xs font-mono h-20"
            placeholder="Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6..."
            value={token}
            onChange={e => setToken(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Cookie（任意 - Authorization で十分なはず）</label>
          <textarea
            className="w-full border rounded p-2 text-xs font-mono h-16"
            placeholder="_ga=...; _session=..."
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
        <button
          onClick={runTest}
          disabled={loading}
          className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? 'テスト中...' : '検索APIをテスト'}
        </button>
      </div>

      {results && (
        <div className="space-y-4">
          <h2 className="text-lg font-bold">結果</h2>
          {results.results.map((r, i) => (
            <div key={i} className={`border rounded p-3 ${r.status === 200 ? 'border-green-400 bg-green-50' : 'border-gray-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`font-bold px-2 py-0.5 rounded text-sm ${r.status === 200 ? 'bg-green-500 text-white' : 'bg-gray-200'}`}>
                  {r.status}
                </span>
                {r.itemCount !== undefined && (
                  <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-sm font-bold">
                    {r.itemCount}件
                  </span>
                )}
                <code className="text-xs text-gray-600 truncate">{r.url}</code>
              </div>
              <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto whitespace-pre-wrap">{r.preview}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
