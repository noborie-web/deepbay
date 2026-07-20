'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Trash2, Link, ChevronUp, ChevronDown } from 'lucide-react'
import type { Product } from '@/types/database'
import TitleEditModal, { applyOp } from './TitleEditModal'
import type { TitleEditOp, TitleEditScope } from './TitleEditModal'
import PriceEditModal from './PriceEditModal'
import ConditionEditModal from './ConditionEditModal'

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
  const [saveError, setSaveError] = useState<string | null>(null)
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
  const [edits, setEdits] = useState<Record<string, Partial<Product & { purchase_price_jpy: number | null }>>>({})

  // 除外タブ
  const [excludeRunning, setExcludeRunning] = useState<Record<string, boolean>>({})
  const [excludeMsg, setExcludeMsg] = useState('')
  const [excludePanel, setExcludePanel] = useState<string | null>(null)

  // スポット文字
  const SPOT_PRESETS = ['難あり', 'ジャンク', '破損', '動作未確認', '訳あり', '傷あり', 'シミ', '汚れ', 'カビ', '臭い', 'NG']
  const [spotSelected, setSpotSelected] = useState<Set<string>>(new Set())
  const [spotCustom, setSpotCustom] = useState('')

  // 価格範囲
  const [priceMin, setPriceMin] = useState('')
  const [priceMax, setPriceMax] = useState('')
  const [priceTarget, setPriceTarget] = useState<'original' | 'ebay'>('original')

  // 簡易除外
  const [quickKeywords, setQuickKeywords] = useState('')

  // 評価数フィルタ
  const [ratingMax, setRatingMax] = useState('')

  // 発送日数フィルタ
  const [shippingDaysMax, setShippingDaysMax] = useState('')

  // 最終更新月フィルタ
  const [updatedMonthsAgo, setUpdatedMonthsAgo] = useState('3')

  // 編集モーダル
  const [titleModalOpen, setTitleModalOpen] = useState(false)
  const [priceModalOpen, setPriceModalOpen] = useState(false)
  const [conditionModalOpen, setConditionModalOpen] = useState(false)

  function togglePanel(key: string) {
    setExcludePanel((v) => v === key ? null : key)
    setExcludeMsg('')
  }

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
      return sellerUrls.some((s) => norm.startsWith(s))
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

  async function excludeSpotWords(): Promise<string[]> {
    const keywords = [
      ...Array.from(spotSelected),
      ...spotCustom.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean),
    ].map((w) => w.toLowerCase())
    if (keywords.length === 0) return []
    const toDelete = products.filter((p) => {
      const lower = p.original_title.toLowerCase()
      return keywords.some((w) => lower.includes(w))
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

  async function excludeByPrice(): Promise<string[]> {
    const min = priceMin !== '' ? Number(priceMin) : null
    const max = priceMax !== '' ? Number(priceMax) : null
    if (min === null && max === null) return []
    const toDelete = products.filter((p) => {
      const price = priceTarget === 'original' ? (p.original_price ?? 0) : (p.ebay_price ?? 0)
      if (min !== null && price < min) return true
      if (max !== null && price > max) return true
      return false
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

  async function excludeByRating(): Promise<string[]> {
    const max = ratingMax !== '' ? Number(ratingMax) : null
    if (max === null) return []
    const toDelete = products.filter((p) =>
      p.seller_rating_count !== null && p.seller_rating_count <= max
    )
    await Promise.all(toDelete.map((p) =>
      fetch(`/api/products/${extractionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id }),
      })
    ))
    return toDelete.map((p) => p.id)
  }

  async function excludeByShippingDays(): Promise<string[]> {
    const max = shippingDaysMax !== '' ? Number(shippingDaysMax) : null
    if (max === null) return []
    const toDelete = products.filter((p) =>
      p.shipping_days !== null && p.shipping_days > max
    )
    await Promise.all(toDelete.map((p) =>
      fetch(`/api/products/${extractionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id }),
      })
    ))
    return toDelete.map((p) => p.id)
  }

  async function excludeByUpdatedAt(): Promise<string[]> {
    const months = Number(updatedMonthsAgo) || 3
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    const toDelete = products.filter((p) => {
      if (!p.source_updated_at) return false
      return new Date(p.source_updated_at) < cutoff
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

  async function excludeQuick(): Promise<string[]> {
    const keywords = quickKeywords.split(/[,、\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (keywords.length === 0) return []
    const toDelete = products.filter((p) => {
      const lower = p.original_title.toLowerCase()
      return keywords.some((w) => lower.includes(w))
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

  const updateEdit = useCallback((productId: string, field: string, value: unknown) => {
    setEdits((prev) => ({
      ...prev,
      [productId]: { ...prev[productId], [field]: value },
    }))
  }, [])

  // ---- 一括タイトル編集 ----
  function applyTitleEdit(op: TitleEditOp, scope: TitleEditScope) {
    const targets = scope === 'page'
      ? pagedProducts.map((p) => p.id)
      : products.map((p) => p.id)
    targets.forEach((id) => {
      const p = products.find((x) => x.id === id)
      if (!p) return
      const before = edits[id]?.ebay_title !== undefined ? (edits[id].ebay_title as string) : (p.ebay_title ?? '')
      // applyOp が常に80文字以内を返す
      const after = applyOp(before, op)
      updateEdit(id, 'ebay_title', after)
    })
  }

  // ---- 一括価格編集 ----
  function applyPriceEdit(getPriceUsd: (p: Product) => number | null, scope: 'page' | 'all') {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((p) => {
      const price = getPriceUsd(p)
      if (price !== null) updateEdit(p.id, 'ebay_price', price)
    })
  }

  // ---- 一括商品状態編集 ----
  function applyConditionEdit(condition: string, scope: 'page' | 'all') {
    const targets = scope === 'page' ? pagedProducts : products
    targets.forEach((p) => updateEdit(p.id, 'ebay_condition', condition))
  }

  // ---- 一括保存 (Bulk API) ----
  async function saveAll() {
    setSaving(true)
    setSaveError(null)
    try {
      const updates = Object.entries(edits).map(([productId, fields]) => {
        // タイトルは常に80文字以内
        const ebay_title = typeof fields.ebay_title === 'string'
          ? fields.ebay_title.slice(0, 80)
          : fields.ebay_title
        const out: Record<string, unknown> = { productId }
        if (ebay_title !== undefined) out.ebay_title = ebay_title
        // null = 明示的クリア; 保存ボタンは不正価格がある間は無効なので、ここに届くのは null か正の有限数のみ
        if (fields.ebay_price !== undefined) out.ebay_price = fields.ebay_price
        if (fields.ebay_condition !== undefined) out.ebay_condition = fields.ebay_condition
        if (fields.purchase_price_jpy !== undefined) out.purchase_price_jpy = fields.purchase_price_jpy
        return out
      })

      const res = await fetch(`/api/products/${extractionId}/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      })

      const json: { ok?: boolean; succeeded?: string[]; failed?: { productId: string; error: string }[] }
        = await res.json().catch(() => ({}))

      if (json.ok === true) {
        // 全成功
        setProducts((prev) =>
          prev.map((p) => (edits[p.id] ? { ...p, ...edits[p.id] } : p))
        )
        setEdits({})
      } else if (json.succeeded && json.failed) {
        // 部分失敗 — 成功分だけ edits をクリア、失敗分は保持
        const succeededSet = new Set(json.succeeded)
        const failedSet = new Set(json.failed.map((f) => f.productId))
        setProducts((prev) =>
          prev.map((p) => (succeededSet.has(p.id) ? { ...p, ...edits[p.id] } : p))
        )
        setEdits((prev) => {
          const next = { ...prev }
          for (const id of succeededSet) delete next[id]
          return next
        })
        const firstErrors = json.failed.slice(0, 3).map((f) => `${f.productId.slice(0, 8)}: ${f.error}`).join(' / ')
        setSaveError(`${failedSet.size}件の保存に失敗しました — ${firstErrors}`)
      } else {
        setSaveError('保存に失敗しました')
      }
    } catch (e) {
      setSaveError(`通信エラー: ${e instanceof Error ? e.message : '不明なエラー'}`)
    } finally {
      setSaving(false)
    }
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
  const pagedIds = new Set(pagedProducts.map((p) => p.id))

  const getTitle = (p: Product) =>
    edits[p.id]?.ebay_title !== undefined ? (edits[p.id].ebay_title as string) : (p.ebay_title ?? '')
  const getPrice = (p: Product): number | null =>
    edits[p.id]?.ebay_price !== undefined ? (edits[p.id].ebay_price as number | null) : p.ebay_price

  // 不正価格: edits に入っているが null でもなく正の有限数でもない
  const hasPriceError = Object.values(edits).some((fields) => {
    const p = fields.ebay_price
    return p !== undefined && p !== null && (typeof p !== 'number' || !isFinite(p) || p <= 0)
  })
  const getCondition = (p: Product) =>
    (edits[p.id]?.ebay_condition as string | undefined) ?? p.ebay_condition ?? '中古'
  // purchase_price_jpy が優先; なければ original_price を表示専用に使用
  const getPurchaseJpy = (p: Product): number | null => {
    const fromEdit = edits[p.id]?.purchase_price_jpy
    if (fromEdit !== undefined) return fromEdit
    if (p.purchase_price_jpy != null) return p.purchase_price_jpy
    return p.original_price ?? null
  }

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
                disabled={saving || Object.keys(edits).length === 0 || hasPriceError}
                className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1 text-xs font-medium transition-colors"
              >
                💾 編集保存
              </button>
              {saveError && (
                <span className="text-xs text-red-500">{saveError}</span>
              )}
            </div>
          )}

          {/* 除外タブ */}
          {tab === 'exclude' && (
            <div className="border-b bg-gray-50">
              <div className="px-4 py-4 grid grid-cols-5 gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-400">Vero</span>
                  <button type="button" disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-300 cursor-not-allowed">除外</button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">危険セラー</span>
                  <button type="button" disabled={excludeRunning['seller']} onClick={() => runExclude('seller', excludeDangerSellers)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                    {excludeRunning['seller'] ? '...' : '除外'}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">危険単語</span>
                  <button type="button" disabled={excludeRunning['word']} onClick={() => runExclude('word', excludeDangerWords)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed">
                    {excludeRunning['word'] ? '...' : '除外'}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">スポット文字</span>
                  <button type="button" onClick={() => togglePanel('spot')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'spot' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">評価数</span>
                  <button type="button" onClick={() => togglePanel('rating')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'rating' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">発送日数</span>
                  <button type="button" onClick={() => togglePanel('shipping')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'shipping' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">最終更新月</span>
                  <button type="button" onClick={() => togglePanel('updated')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'updated' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-400">価格タイプ</span>
                  <button type="button" disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-300 cursor-not-allowed">除外</button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">価格範囲</span>
                  <button type="button" onClick={() => togglePanel('price')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'price' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">簡易除外</span>
                  <button type="button" onClick={() => togglePanel('quick')}
                    className={`border rounded px-2.5 py-1 text-xs transition-colors ${excludePanel === 'quick' ? 'bg-blue-500 text-white border-blue-500' : 'border-blue-400 text-blue-600 hover:bg-blue-50'}`}>
                    除外
                  </button>
                </div>
              </div>

              {excludePanel === 'rating' && (
                <div className="mx-4 mb-2 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">セラー評価数がN件以下の商品を除外します（メルカリのみ対応）</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-600">評価数</span>
                    <input type="number" value={ratingMax} onChange={(e) => setRatingMax(e.target.value)}
                      placeholder="例: 10" min="0"
                      className="border rounded px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                    <span className="text-xs text-gray-500">件以下を除外</span>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['rating']} onClick={() => runExclude('rating', excludeByRating)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['rating'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'shipping' && (
                <div className="mx-4 mb-2 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">発送まで指定日数より長い商品を除外します（メルカリのみ対応）</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-600">発送日数</span>
                    <input type="number" value={shippingDaysMax} onChange={(e) => setShippingDaysMax(e.target.value)}
                      placeholder="例: 3" min="1"
                      className="border rounded px-2 py-1 text-xs w-24 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                    <span className="text-xs text-gray-500">日超を除外</span>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['shipping']} onClick={() => runExclude('shipping', excludeByShippingDays)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['shipping'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'updated' && (
                <div className="mx-4 mb-2 p-3 bg-white border rounded-lg space-y-2">
                  <p className="text-xs text-gray-500">最終更新が古い商品を除外します（メルカリのみ対応）</p>
                  <div className="flex items-center gap-2">
                    <select value={updatedMonthsAgo} onChange={(e) => setUpdatedMonthsAgo(e.target.value)}
                      className="border rounded px-2 py-1 text-xs focus:outline-none">
                      {[1, 2, 3, 6, 12].map((n) => (
                        <option key={n} value={String(n)}>{n}ヶ月以上前</option>
                      ))}
                    </select>
                    <span className="text-xs text-gray-500">に更新された商品を除外</span>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['updated']} onClick={() => runExclude('updated', excludeByUpdatedAt)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['updated'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'spot' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {SPOT_PRESETS.map((w) => (
                      <button key={w} type="button"
                        onClick={() => setSpotSelected((prev) => { const s = new Set(prev); s.has(w) ? s.delete(w) : s.add(w); return s })}
                        className={`px-2 py-0.5 rounded text-xs border transition-colors ${spotSelected.has(w) ? 'bg-orange-500 text-white border-orange-500' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`}>
                        {w}
                      </button>
                    ))}
                  </div>
                  <input type="text" value={spotCustom} onChange={(e) => setSpotCustom(e.target.value)}
                    placeholder="カスタムキーワード（カンマ区切り）"
                    className="w-full border rounded px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['spot']} onClick={() => runExclude('spot', excludeSpotWords)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['spot'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'price' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-500">対象</span>
                      <select value={priceTarget} onChange={(e) => setPriceTarget(e.target.value as 'original' | 'ebay')}
                        className="border rounded px-2 py-1 text-xs focus:outline-none">
                        <option value="original">仕入れ価格（円）</option>
                        <option value="ebay">eBay価格（$）</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input type="number" value={priceMin} onChange={(e) => setPriceMin(e.target.value)}
                        placeholder="最小" className="border rounded px-2 py-1 text-xs w-24 focus:outline-none" />
                      <span className="text-xs text-gray-400">〜</span>
                      <input type="number" value={priceMax} onChange={(e) => setPriceMax(e.target.value)}
                        placeholder="最大" className="border rounded px-2 py-1 text-xs w-24 focus:outline-none" />
                      <span className="text-xs text-gray-500">{priceTarget === 'original' ? '円' : '$'} の範囲外を除外</span>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['price']} onClick={() => runExclude('price', excludeByPrice)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['price'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludePanel === 'quick' && (
                <div className="mx-4 mb-4 p-3 bg-white border rounded-lg space-y-2">
                  <textarea value={quickKeywords} onChange={(e) => setQuickKeywords(e.target.value)}
                    placeholder="キーワードをカンマ・改行区切りで入力（タイトルに含む商品を除外）"
                    rows={3}
                    className="w-full border rounded px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none" />
                  <div className="flex justify-end">
                    <button type="button" disabled={excludeRunning['quick']} onClick={() => runExclude('quick', excludeQuick)}
                      className="bg-blue-500 hover:bg-blue-600 text-white rounded px-4 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                      {excludeRunning['quick'] ? '実行中...' : '除外を実行'}
                    </button>
                  </div>
                </div>
              )}

              {excludeMsg && (
                <p className="mx-4 mb-4 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{excludeMsg}</p>
              )}
            </div>
          )}

          {/* 編集タブ */}
          {tab === 'edit' && (
            <div className="px-4 py-4 border-b bg-gray-50">
              <div className="grid grid-cols-5 gap-3">
                {/* タイトル — 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">タイトル</span>
                  <button onClick={() => setTitleModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* ブランド — Phase 2 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-400">ブランド</span>
                  <button disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-300 cursor-not-allowed">準備中</button>
                </div>
                {/* 商品詳細 — Phase 2 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-400">商品詳細</span>
                  <button disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-300 cursor-not-allowed">準備中</button>
                </div>
                {/* 画像枚数以降 — Phase 2 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-400">画像枚数以降</span>
                  <button disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-300 cursor-not-allowed">準備中</button>
                </div>
                {/* 商品状態 — 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">商品状態</span>
                  <button onClick={() => setConditionModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* 価格 — 実装済み */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-700">価格</span>
                  <button onClick={() => setPriceModalOpen(true)}
                    className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50">編集</button>
                </div>
                {/* アイテムスペシフィック — Phase 2 */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-400">アイテムスペシフィック</span>
                  <button disabled className="border border-gray-200 rounded px-2.5 py-1 text-xs text-gray-300 cursor-not-allowed">準備中</button>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-end gap-3">
                <button
                  onClick={saveAll}
                  disabled={saving || Object.keys(edits).length === 0 || hasPriceError}
                  className="flex items-center gap-1.5 bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white rounded px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  💾 編集保存
                </button>
                {saveError && (
                  <span className="text-xs text-red-500">{saveError}</span>
                )}
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
                              onChange={(e) => updateEdit(product.id, 'ebay_title', e.target.value.slice(0, 80))}
                              maxLength={80}
                              placeholder="翻訳後タイトル"
                              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                            />
                            <span className={`absolute right-2 bottom-2 text-xs ${getTitle(product).length >= 80 ? 'text-red-400' : 'text-gray-400'}`}>
                              {getTitle(product).length} / 80
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-gray-400 truncate">{product.original_title}</p>
                        </div>

                        {/* 右: 価格・状態 (ブランドはPhase 2で実装) */}
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-xs text-gray-500 block mb-0.5">
                                eBay販売価格
                                {getPrice(product) == null && (
                                  <span className="ml-1 text-amber-500">未設定</span>
                                )}
                              </label>
                              <div className={`flex items-center border rounded overflow-hidden ${
                                getPrice(product) !== null && (getPrice(product)! <= 0 || !isFinite(getPrice(product)!))
                                  ? 'border-red-400' : ''
                              }`}>
                                <input
                                  type="number"
                                  value={getPrice(product) ?? ''}
                                  onChange={(e) => {
                                    const raw = e.target.value
                                    if (raw === '') {
                                      updateEdit(product.id, 'ebay_price', null)
                                    } else {
                                      const n = parseFloat(raw)
                                      // NaN → null (クリア扱い); 0・負数はそのまま保持してエラー表示
                                      updateEdit(product.id, 'ebay_price', isNaN(n) ? null : n)
                                    }
                                  }}
                                  placeholder="未設定"
                                  className="flex-1 px-2 py-1.5 text-sm focus:outline-none min-w-0"
                                />

                                <span className="px-2 text-xs text-gray-500 bg-gray-50 border-l h-full flex items-center">$</span>
                              </div>
                              {(() => {
                                const v = getPrice(product)
                                return v !== null && (v <= 0 || !isFinite(v))
                                  ? <p className="text-xs text-red-500 mt-0.5">0より大きい値を入力してください</p>
                                  : null
                              })()}
                            </div>
                            <div>
                              <label className="text-xs text-gray-500 block mb-0.5">仕入価格（参照用）</label>
                              <div className="flex items-center border rounded overflow-hidden bg-gray-50">
                                <span className="flex-1 px-2 py-1.5 text-sm text-gray-500 select-none">
                                  {getPurchaseJpy(product) != null ? getPurchaseJpy(product)!.toLocaleString() : '—'}
                                </span>
                                <span className="px-2 text-xs text-gray-400 border-l h-full flex items-center">円</span>
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
              <button onClick={() => setScrollSpeed((v) => Math.min(v + 2, 20))} className="border rounded px-3 py-1.5 text-xs hover:bg-gray-100">加速</button>
              <button onClick={() => setScrollSpeed((v) => Math.max(v - 2, 1))} className="border rounded px-3 py-1.5 text-xs hover:bg-gray-100">減速</button>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-500">スクロール速度</span>
                <input type="number" value={scrollSpeed} onChange={(e) => setScrollSpeed(Number(e.target.value))}
                  className="border rounded px-2 py-1 text-xs w-14 focus:outline-none" />
                <span className="text-xs text-gray-500">px</span>
              </div>

              <div className="ml-auto flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500">Items per page:</span>
                  <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1) }}
                    className="border rounded px-2 py-1 text-xs focus:outline-none">
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

      {/* モーダル */}
      {titleModalOpen && (
        <TitleEditModal
          products={products}
          pagedIds={pagedIds}
          getTitle={getTitle}
          onApply={applyTitleEdit}
          onClose={() => setTitleModalOpen(false)}
        />
      )}
      {priceModalOpen && (
        <PriceEditModal
          products={products}
          pagedIds={pagedIds}
          getPurchaseJpy={getPurchaseJpy}
          onApply={applyPriceEdit}
          onClose={() => setPriceModalOpen(false)}
        />
      )}
      {conditionModalOpen && (
        <ConditionEditModal
          targetCount={{ page: pagedProducts.length, all: products.length }}
          onApply={applyConditionEdit}
          onClose={() => setConditionModalOpen(false)}
        />
      )}
    </div>
  )
}
