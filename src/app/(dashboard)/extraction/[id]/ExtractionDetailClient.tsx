'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import type { Extraction, Product } from '@/types/database'

interface Props {
  extraction: Extraction
  initialProducts: Product[]
}

export default function ExtractionDetailClient({ extraction: initial, initialProducts }: Props) {
  const [extraction, setExtraction] = useState(initial)
  const [products, setProducts] = useState(initialProducts)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (extraction.status === 'processing') {
      intervalRef.current = setInterval(async () => {
        const res = await fetch(`/api/extraction-status/${extraction.id}`)
        if (!res.ok) return
        const data = await res.json()
        setExtraction(data.extraction)
        setProducts(data.products)
        if (data.extraction.status !== 'processing') {
          clearInterval(intervalRef.current!)
        }
      }, 3000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ユーザー要望: ヤフオク・Yahoo!フリマは相手サイトのアクセス制限で抽出中に
  // 全件の詳細(説明文・状態・発送日数・評価数)を取り切れないことがあるため、
  // 抽出完了後に残りを少しずつ補完する(このページを開いている間に自動で進む)。
  const [enrichPending, setEnrichPending] = useState<number | null>(null)
  const [enrichDone, setEnrichDone] = useState(0)
  const [enrichError, setEnrichError] = useState<string | null>(null)
  // Yahoo!フリマの制限(約15件/15分)で待機中のとき、次の再開時刻
  const [enrichResumeAt, setEnrichResumeAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const enrichStartedRef = useRef(false)

  useEffect(() => {
    if (extraction.status !== 'completed' || enrichStartedRef.current) return
    enrichStartedRef.current = true
    let cancelled = false
    const call = async (mode: 'status' | 'run') => {
      const res = await fetch(`/api/extractions/${extraction.id}/enrich-details`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '詳細の補完に失敗しました')
      return json as { pending: number; processed?: number; retry_after_ms?: number; flea_rate_limited?: boolean }
    }
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    ;(async () => {
      try {
        const status = await call('status')
        if (cancelled) return
        setEnrichPending(status.pending)
        let pending = status.pending
        for (let i = 0; i < 200 && pending > 0 && !cancelled; i++) {
          const result = await call('run')
          if (cancelled) return
          setEnrichDone(prev => prev + (result.processed ?? 0))
          const progressed = (result.processed ?? 0) > 0 || result.pending < pending
          pending = result.pending
          setEnrichPending(pending)
          if (pending === 0) break
          if (result.retry_after_ms && result.retry_after_ms > 0) {
            // Yahoo!フリマの制限: 次の1回分まで待つ
            const resumeAt = Date.now() + result.retry_after_ms
            setEnrichResumeAt(resumeAt)
            while (!cancelled && Date.now() < resumeAt) await sleep(1000)
            setEnrichResumeAt(null)
            continue
          }
          if (!progressed) break
        }
        if (!cancelled) {
          const refreshed = await fetch(`/api/extraction-status/${extraction.id}`)
          if (refreshed.ok) {
            const data = await refreshed.json()
            setProducts(data.products)
          }
        }
      } catch (e) {
        if (!cancelled) setEnrichError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [extraction.status, extraction.id])

  // 待機中のカウントダウン表示用
  useEffect(() => {
    if (enrichResumeAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [enrichResumeAt])

  const isProcessing = extraction.status === 'processing'
  const progress = extraction.progress ?? 0

  return (
    <div className="p-6">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/extraction" className="text-sm text-gray-500 hover:text-gray-700">← 抽出一覧</Link>
        <h1 className="text-xl font-bold">抽出結果</h1>
        <span className={`text-xs px-2 py-1 rounded ${
          extraction.status === 'completed' ? 'bg-green-100 text-green-700' :
          extraction.status === 'failed' ? 'bg-red-100 text-red-700' :
          'bg-yellow-100 text-yellow-700'
        }`}>
          {extraction.status === 'processing' ? '抽出中...' : extraction.status}
        </span>
      </div>

      {isProcessing && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-blue-700">スクレイピング中...</span>
            <span className="text-sm font-bold text-blue-700">{progress}%</span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-3">
            <div
              className="bg-blue-600 h-3 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-blue-500 mt-2">現在 {products.length} 件取得済み。3秒ごとに自動更新されます。</p>
        </div>
      )}

      {enrichPending !== null && enrichPending > 0 && !enrichError && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          商品ページから説明文・画像などを補完中… 残り {enrichPending} 件（補完済み {enrichDone} 件）。
          {enrichResumeAt !== null && (
            <> Yahoo!フリマのアクセス制限（約15件ごとに15分待機）のため、あと {Math.max(0, Math.ceil((enrichResumeAt - now) / 60000))} 分後に再開します。</>
          )}
          このページを開いたままお待ちください（閉じても次回開いたときに続きから再開します）。
        </div>
      )}
      {enrichPending === 0 && enrichDone > 0 && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          商品詳細の補完が完了しました（{enrichDone} 件）。
        </div>
      )}
      {enrichError && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          商品詳細の補完でエラー: {enrichError}（ページを再読み込みすると再開します）
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500">抽出サイト</div>
          <div className="font-medium">{extraction.source_site}</div>
        </div>
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500">商品数</div>
          <div className="font-bold text-2xl">{products.length}件</div>
        </div>
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500">抽出元URL</div>
          <div className="text-xs truncate text-blue-600">{extraction.source_url}</div>
        </div>
      </div>

      <div className="border rounded-md overflow-hidden">
        <div className="grid grid-cols-[80px_1fr_120px_120px_100px] gap-3 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
          <span>画像</span>
          <span>商品名</span>
          <span>元価格</span>
          <span>状態</span>
          <span>リンク</span>
        </div>
        {products.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">
            {isProcessing ? '取得中...' : '商品がありません'}
          </div>
        ) : (
          products.map((product) => (
            <div key={product.id} className="grid grid-cols-[80px_1fr_120px_120px_100px] gap-3 px-4 py-3 border-b items-center hover:bg-gray-50">
              <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                {product.original_images?.[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={product.original_images[0]} alt="" className="w-full h-full object-cover" />
                )}
              </div>
              <div>
                <div className="text-sm font-medium line-clamp-2">{product.original_title}</div>
                <div className="text-xs text-gray-400 mt-1">{product.source_item_id}</div>
              </div>
              <div className="text-sm font-medium">
                {product.original_price ? `¥${product.original_price.toLocaleString()}` : '—'}
              </div>
              <div className="text-sm text-gray-600">{product.original_condition ?? '—'}</div>
              <div>
                <a href={product.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">
                  元ページ
                </a>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
