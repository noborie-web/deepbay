'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Trash2, Link, ChevronUp, ChevronDown } from 'lucide-react'
import type { Product } from '@/types/database'

interface Props {
  extractionId: string
  onClose: () => void
}

type Tab = 'main' | 'exclude' | 'edit' | 'search' | 'pokemon'
type ImageSize = '小' | '中' | '大'
type EditMode = '簡易編集モード' | '詳細編集モード'

const IMAGE_SIZE_MAP: Record<ImageSize, string> = {
  小: 'w-20 h-20',
  中: 'w-32 h-32',
  大: 'w-48 h-48',
}

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200]

export default function ProductEditPanel({ extractionId, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('main')
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [imageSize, setImageSize] = useState<ImageSize>('小')
  const [bulkSize, setBulkSize] = useState('50')
  const [editMode, setEditMode] = useState<EditMode>('簡易編集モード')
  const [pageSize, setPageSize] = useState(50)
  const [page, setPage] = useState(1)
  const [collapsed, setCollapsed] = useState(false)
  const [autoScroll, setAutoScroll] = useState(false)
  const [scrollSpeed, setScrollSpeed] = useState(4)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // local edits buffer
  const [edits, setEdits] = useState<Record<string, Partial<Product>>>({})

  // 除外タブ
  const [excludeRunning, setExcludeRunning] = useState<Record<string, boolean>>({})
  const [excludeMsg, setExcludeMsg] = useState('')

  async function runExclude(key: string, fn: () => Promise<string[]>) {
    setExcludeRunning((v) => ({ ...v, [key]: true }))
    setExcludeMsg('')
    try {
      const removedIds = await fn()
      if (removedIds.length > 0) {
        setProducts((prev) => prev.filter((p) => !removedIds.includes(p.id)))
        setExcludeMsg(`${removedIds.length}件を除外しました`)
      } else {
        setExcludeMsg('除外対象がありませんでした')
      }
    } catch {
      setExcludeMsg('エラーが発生しました')
    } finally {
      setExcludeRunning((v) => ({ ...v, [key]: false }))
    }
  }

  async function excludeDangerSellers(): Promise<string[]> {
    const res = await fetch('/api/extraction-settings')
    const data = await res.json()
    const sellerUrls: string[] = (data.sellers ?? []).map((s: { seller_url: string }) =>
      s.seller_url.split('?')[0].trim().replace(/\/+$/, '')
    )
    if (sellerUrls.length === 0) return []
    const toDelete = products.filter((p) => {
      const norm = p.source_url.split('?')[0].trim().replace(/\/+$/, '')
      return sellerUrls.some((s) => norm.includes(s) || s.includes(norm))
    })
    await Promise.all(toDelete.map((p) =>
      fetch(`/api/products/${extractionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id }),
      })
    ))
    return toDelete.map((p) => p.id)
  }

  async function excludeDangerWords(): Promise<string[]> {
    const res = await fetch('/api/extraction-settings')
    const data = await res.json()
    const words: string[] = (data.words ?? []).map((w: { word: string }) => w.word.toLowerCase())
    if (words.length === 0) return []
    const toDelete = products.filter((p) => {
      const lower = p.original_title.toLowerCase()
      return words.some((w) => lower.includes(w))
    })
    await Promise.all(toDelete.map((p) =>
      fetch(`/api/products/${extractionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id }),
      })
    ))
    return toDelete.map((p) => p.id)
  }


  useEffect(() => {
    fetch(`/api/products/${extractionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setProducts(data)
        setLoading(false)
      })
  }, [extractionId])

  // auto scroll
  useEffect(() => {
    if (autoScroll) {
      scrollTimer.current = setInterval(() => {
        scrollRef.current?.scrollBy({ top: scrollSpeed, behavior: 'auto' })
      }, 16)
    } else {
      if (scrollTimer.current) clearInterval(scrollTimer.current)
    }
    return () => { if (scrollTimer.current) clearInterval(scrollTimer.current) }
  }, [autoScroll, scrollSpeed])

  const updateEdit = useCallback((productId: string, field: keyof Product, value: unknown) => {
    setEdits((prev) => ({
      ...prev,
      [productId]: { ...prev[productId], [field]: value },
    }))
  }, [])

  async function saveAll() {
    setSaving(true)
    const entries = Object.entries(edits)
    for (const [productId, updates] of entries) {
      await fetch(`/api/products/${extractionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, ...updates }),
      })
    }
    // reflect edits into products state
    setProducts((prev) =>
      prev.map((p) => (edits[p.id] ? { ...p, ...edits[p.id] } : p))
    )
    setEdits({})
    setSaving(false)
  }

  async function deleteProduct(productId: string) {
    if (!confirm('この商品を削除しますか？')) return
    const res = await fetch(`/api/products/${extractionId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId }),
    })
    if (res.ok) {
      setProducts((prev) => prev.filter((p) => p.id !== productId))
    }
  }

  const totalPages = Math.ceil(products.length / pageSize)
  const pagedProducts = products.slice((page - 1) * pageSize, page * pageSize)

  const getTitle = (p: Product) =>
    edits[p.id]?.ebay_title !== undefined ? (edits[p.id].ebay_title as string) : (p.ebay_title ?? '')
  const getBrand = (p: Product) =>
    (edits[p.id]?.ebay_description as string | undefined) ?? p.ebay_description ?? ''
  const getPrice = (p: Product) =>
    edits[p.id]?.ebay_price !== undefined ? (edits[p.id].ebay_price as number) : (p.ebay_price ?? 0)
  const getCondition = (p: Product) =>
    (edits[p.id]?.ebay_condition as string | undefined) ?? p.ebay_condition ?? '中古'
  const getPurchasePrice = (p: Product) =>
    edits[p.id]?.original_price !== undefined ? (edits[p.id].original_price as number) : (p.original_price ?? 0)

  return (
    <div className="border rounded-lg bg-white mt-2 shadow-sm">
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <button
          onClick={onClose}
          className="text-sm text-gray-600 hover:text-gray-900 font-medium"
        >
          閉じる
        </button>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-gray-400 hover:text-gray-700"
        >
          {collapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* タブ */}
          <div className="flex gap-6 px-4 border-b">
            {([['main', 'メイン'], ['exclude', '除外'], ['edit', '編集'], ['search', '検索'], ['pokemon', 'ポケモン']] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  tab === key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* メインタブ コントロール */}
          {tab === 'main' && (
            <div className="flex items-center gap-4 px-4 py-3 border-b bg-gray-50 flex-wrap">
              {/* 画像サイズ */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">画像サイズ</span>
                <select
                  value={imageSize}
                  onChange={(e) => setImageSize(e.target.value as ImageSize)}
                  className="border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
                >
                  {(['小', '中', '大'] as ImageSize[]).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              {/* 一括サイズ */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">一括サイズ</span>
                <input
                  type="number"
                  value={bulkSize}
                  onChange={(e) => setBulkSize(e.target.value)}
                  className="border rounded px-2 py-1 text-xs w-16 focus:outline-none focus:ring-1 focus:ring-blue-300"
                />
                <button className="border border-blue-400 text-blue-500 rounded px-2.5 py-1 text-xs hover:bg-blue-50">
                  ✓ 適用
                </button>
              </div>
              {/* 編集モード */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">編集モード</span>
                <select
                  value={editMode}
                  onChange={(e) => setEditMode(e.target.value as EditMode)}
                  className="border-2 border-gray-800 rounded px-2 py-1 text-xs font-medium focus:outline-none"
                >
                  <option>簡易編集モード</option>
                  <option>詳細編集モード</option>
                </select>
              </div>
              {/* 編集保存 */}
              <button
                onClick={saveAll}
                disabled={saving || Object.keys(edits).length === 0}
                className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1 text-xs font-medium transition-colors"
              >
                💾 編集保存
              </button>
            </div>
          )}

          {/* 除外タブ */}
          {tab === 'exclude' && (
            <div className="px-4 py-4 border-b bg-gray-50 space-y-3">
              <div className="grid grid-cols-5 gap-3">
                {/* Vero - 未実装 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">Vero</span>
                  <button type="button" disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-400 cursor-not-allowed">除外</button>
                </div>
                {/* 危険セラー - 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">危険セラー</span>
                  <button
                    type="button"
                    disabled={excludeRunning['seller'] ?? false}
                    onClick={() => { alert('危険セラー除外を実行します'); runExclude('seller', excludeDangerSellers) }}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {excludeRunning['seller'] ? '...' : '除外'}
                  </button>
                </div>
                {/* 危険単語 - 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">危険単語</span>
                  <button
                    type="button"
                    disabled={excludeRunning['word'] ?? false}
                    onClick={() => { alert('危険単語除外を実行します'); runExclude('word', excludeDangerWords) }}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {excludeRunning['word'] ? '...' : '除外'}
                  </button>
                </div>
                {/* 未実装ボタン群 */}
                {['スポット文字', '評価数', '発送日数', '最終更新月', '価格範囲', '価格タイプ', '簡易除外'].map((label) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-700">{label}</span>
                    <button type="button" disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-400 cursor-not-allowed">除外</button>
                  </div>
                ))}
              </div>
              {excludeMsg && (
                <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{excludeMsg}</p>
              )}
            </div>
          )}

          {/* 編集タブ */}
          {tab === 'edit' && (
            <div className="px-4 py-4 border-b bg-gray-50">
              <div className="grid grid-cols-5 gap-3">
                {['タイトル', 'ブランド', '商品詳細', '画像枚数以降', '商品状態', '価格', 'アイテムスペシフィック'].map((label) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-700">{label}</span>
                    <button className="border border-gray-300 rounded px-2.5 py-1 text-xs hover:bg-gray-100">編集</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 検索・ポケモンタブ（未実装プレースホルダー） */}
          {(tab === 'search' || tab === 'pokemon') && (
            <div className="px-4 py-8 text-center text-sm text-gray-400 border-b">未実装</div>
          )}

          {/* 商品リスト */}
          {(tab === 'main' || tab === 'exclude' || tab === 'edit') && (
            <div ref={scrollRef} className="overflow-y-auto max-h-[70vh]">
              {loading ? (
                <div className="py-12 text-center text-sm text-gray-400">読み込み中...</div>
              ) : pagedProducts.length === 0 ? (
                <div className="py-12 text-center text-sm text-gray-400">商品がありません</div>
              ) : (
                pagedProducts.map((product) => (
                  <div key={product.id} className="border-b last:border-0 px-4 py-4">
                    <div className="flex gap-4">
                      {/* アクションボタン */}
                      <div className="flex flex-col gap-2 items-center pt-1 shrink-0">
                        <button
                          onClick={() => deleteProduct(product.id)}
                          className="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center"
                        >
                          <Trash2 size={14} />
                        </button>
                        <a
                          href={product.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-8 h-8 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center"
                        >
                          <Link size={14} />
                        </a>
                      </div>

                      {/* メイン画像 */}
                      <div className={`shrink-0 ${IMAGE_SIZE_MAP[imageSize]}`}>
                        {product.original_images[0] ? (
                          <img
                            src={product.original_images[0]}
                            alt=""
                            className="w-full h-full object-cover rounded border"
                          />
                        ) : (
                          <div className="w-full h-full bg-gray-100 rounded border flex items-center justify-center text-gray-300 text-xs">No image</div>
                        )}
                      </div>

                      {/* 編集フィールド */}
                      <div className="flex-1 grid grid-cols-[1fr_200px] gap-4">
                        {/* 左: タイトル */}
                        <div>
                          <div className="relative">
                            <input
                              type="text"
                              value={getTitle(product)}
                              onChange={(e) => updateEdit(product.id, 'ebay_title', e.target.value)}
                              maxLength={80}
                              placeholder="翻訳後タイトル"
                              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                            />
                            <span className="absolute right-2 bottom-2 text-xs text-gray-400">
                              {getTitle(product).length} / 80
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-gray-400 truncate">{product.original_title}</p>
                        </div>

                        {/* 右: ブランド・価格・状態 */}
                        <div className="space-y-2">
                          <div>
                            <label className="text-xs text-gray-500 block mb-0.5">ブランド</label>
                            <input
                              type="text"
                              value={getBrand(product)}
                              onChange={(e) => updateEdit(product.id, 'ebay_description', e.target.value)}
                              placeholder="ブランド"
                              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-xs text-gray-500 block mb-0.5">ebay販売価格</label>
                              <div className="flex items-center border rounded overflow-hidden">
                                <input
                                  type="number"
                                  value={getPrice(product)}
                                  onChange={(e) => updateEdit(product.id, 'ebay_price', parseFloat(e.target.value))}
                                  className="flex-1 px-2 py-1.5 text-sm focus:outline-none min-w-0"
                                />
                                <span className="px-2 text-xs text-gray-500 bg-gray-50 border-l h-full flex items-center">$</span>
                              </div>
                            </div>
                            <div>
                              <label className="text-xs text-gray-500 block mb-0.5">仕入価格</label>
                              <div className="flex items-center border rounded overflow-hidden">
                                <input
                                  type="number"
                                  value={getPurchasePrice(product)}
                                  onChange={(e) => updateEdit(product.id, 'original_price', parseFloat(e.target.value))}
                                  className="flex-1 px-2 py-1.5 text-sm focus:outline-none min-w-0"
                                />
                                <span className="px-2 text-xs text-gray-500 bg-gray-50 border-l h-full flex items-center">円</span>
                              </div>
                            </div>
                          </div>
                          <div>
                            <label className="text-xs text-gray-500 block mb-0.5">商品状態</label>
                            <select
                              value={getCondition(product)}
                              onChange={(e) => updateEdit(product.id, 'ebay_condition', e.target.value)}
                              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300"
                            >
                              {['新品', '新品同様', '良い', '普通', '中古', 'ジャンク'].map((c) => (
                                <option key={c}>{c}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* サムネイル */}
                    {product.original_images.length > 1 && (
                      <div className="flex gap-2 mt-3 ml-[5.5rem] overflow-x-auto pb-1">
                        {product.original_images.slice(0, 12).map((img, i) => (
                          <img
                            key={i}
                            src={img}
                            alt=""
                            className="w-14 h-14 object-cover rounded border shrink-0"
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* ボトムバー */}
          {(tab === 'main' || tab === 'exclude' || tab === 'edit') && (
            <div className="flex items-center gap-3 px-4 py-3 border-t bg-gray-50 flex-wrap">
              <button
                onClick={() => setAutoScroll((v) => !v)}
                className={`border rounded px-3 py-1.5 text-xs transition-colors ${
                  autoScroll ? 'bg-blue-500 text-white border-blue-500' : 'hover:bg-gray-100'
                }`}
              >
                自動スクロール
              </button>
              <button
                onClick={() => setScrollSpeed((v) => Math.min(v + 2, 20))}
                className="border rounded px-3 py-1.5 text-xs hover:bg-gray-100"
              >
                加速
              </button>
              <button
                onClick={() => setScrollSpeed((v) => Math.max(v - 2, 1))}
                className="border rounded px-3 py-1.5 text-xs hover:bg-gray-100"
              >
                減速
              </button>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">スクロール速度</span>
                <input
                  type="number"
                  value={scrollSpeed}
                  onChange={(e) => setScrollSpeed(Number(e.target.value))}
                  className="border rounded px-2 py-1 text-xs w-14 focus:outline-none"
                />
                <span className="text-xs text-gray-500">px</span>
              </div>

              <div className="ml-auto flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500">Items per page:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}
                    className="border rounded px-2 py-1 text-xs focus:outline-none"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => <option key={n}>{n}</option>)}
                  </select>
                </div>
                <span className="text-xs text-gray-600">
                  {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, products.length)} of {products.length}
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage(1)} disabled={page === 1} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">|◀</button>
                  <button onClick={() => setPage((v) => Math.max(v - 1, 1))} disabled={page === 1} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">◀</button>
                  <button onClick={() => setPage((v) => Math.min(v + 1, totalPages))} disabled={page === totalPages} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">▶</button>
                  <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="px-1.5 py-1 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">▶|</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
