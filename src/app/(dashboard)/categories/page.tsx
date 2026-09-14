'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { EBAY_CATEGORIES } from '@/data/ebay-categories'
import {
  CONDITION_GRADES,
  EBAY_CONDITION_OPTIONS,
  MEDIA_CONDITION_MAP,
  STANDARD_CONDITION_MAP,
} from '@/lib/listing-export'
import type { ListingCategory } from '@/types/database'

interface EbayCategory { id: string; name: string; level?: number }

export default function CategoriesPage() {
  const router = useRouter()
  const [tab, setTab] = useState<'add' | 'manage'>('add')
  const [categoryId, setCategoryId] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [searchTitle, setSearchTitle] = useState('')
  const [searchResults, setSearchResults] = useState<EbayCategory[]>([])
  const [categories, setCategories] = useState<ListingCategory[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftMap, setDraftMap] = useState<Record<string, string>>({})
  const [savingMap, setSavingMap] = useState(false)

  const [supabase] = useState(createClient)

  const loadCategories = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from('listing_categories')
      .select('*')
      .order('sort_order', { ascending: true })
    return (data ?? []) as ListingCategory[]
  }, [supabase])

  const fetchCategories = useCallback(async () => {
    setCategories(await loadCategories())
  }, [loadCategories])

  useEffect(() => {
    let active = true
    void loadCategories().then((data) => {
      if (active) setCategories(data)
    })
    return () => { active = false }
  }, [loadCategories])

  async function handleSearch() {
    const q = searchTitle.trim()
    if (!q) return
    // DBから検索（インポート済みの場合）、なければ静的データにフォールバック
    try {
      const res = await fetch(`/api/ebay-categories?q=${encodeURIComponent(q)}`)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data) && data.length > 0) {
          setSearchResults(data)
          return
        }
      }
    } catch { /* fallback */ }
    // 静的データで検索
    const ql = q.toLowerCase()
    const results = EBAY_CATEGORIES.filter(
      (cat) => cat.name.toLowerCase().includes(ql) || cat.id.includes(ql)
    ).slice(0, 50)
    setSearchResults(results)
  }

  async function addCategory(ebayId: string, name: string) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const alreadyExists = categories.some((c) => c.ebay_category_id === ebayId)
    if (alreadyExists) {
      setSuccessMsg(`「${name}」はすでに登録済みです`)
      setTimeout(() => setSuccessMsg(''), 3000)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: err } = await (supabase as any).from('listing_categories').insert({
      user_id: user.id,
      ebay_category_id: ebayId,
      name,
      sort_order: categories.length,
    })
    if (!err) {
      setSuccessMsg(`「${name}」を追加しました`)
      setTimeout(() => setSuccessMsg(''), 3000)
      fetchCategories()
    }
  }

  async function handleAdd() {
    if (!categoryId.trim() || !categoryName.trim()) {
      setError('カテゴリIDと識別名は必須です')
      return
    }
    setError('')
    setLoading(true)
    await addCategory(categoryId.trim(), categoryName.trim())
    setCategoryId('')
    setCategoryName('')
    setLoading(false)
  }

  async function handleDelete(id: string) {
    if (!confirm('このカテゴリを削除しますか？')) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('listing_categories').delete().eq('id', id)
    fetchCategories()
  }

  // ---- 商品状態→ConditionIDのカテゴリー別設定 ----
  // eBayのConditionIDはカテゴリごとに有効な値が違い、例えばCD(176984)は
  // 3000(Used)を受け付けずアップロードが全件失敗する。カテゴリ単位で
  // 対応表を設定できるようにする。
  function openConditionEditor(cat: ListingCategory) {
    setEditingId(cat.id)
    setDraftMap({ ...STANDARD_CONDITION_MAP, ...(cat.condition_map ?? {}) })
  }

  async function saveConditionMap(id: string) {
    setSavingMap(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: err } = await (supabase as any)
      .from('listing_categories')
      .update({ condition_map: draftMap })
      .eq('id', id)
    setSavingMap(false)
    if (err) {
      setError(`保存に失敗しました: ${err.message}`)
      return
    }
    setEditingId(null)
    setSuccessMsg('商品状態の設定を保存しました')
    setTimeout(() => setSuccessMsg(''), 3000)
    fetchCategories()
  }

  async function clearConditionMap(id: string) {
    if (!confirm('このカテゴリの設定を解除して標準マッピングに戻しますか？')) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('listing_categories').update({ condition_map: null }).eq('id', id)
    setEditingId(null)
    fetchCategories()
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold">出品カテゴリー管理</h1>
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-4 py-1.5 transition-colors"
        >
          閉じる
        </button>
      </div>

      {/* タブ */}
      <div className="flex gap-6 border-b mb-6">
        {[
          { key: 'add', label: 'カテゴリー追加' },
          { key: 'manage', label: '登録済みカテゴリー管理' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key as 'add' | 'manage')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === key ? 'border-gray-800 text-gray-800' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {successMsg && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
          {successMsg}
        </div>
      )}

      {tab === 'add' && (
        <div className="space-y-4">
          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* 直接入力フォーム */}
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="*カテゴリID"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <input
              type="text"
              placeholder="*カテゴリ識別名"
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <button
              onClick={handleAdd}
              disabled={loading}
              className="bg-blue-400 hover:bg-blue-500 text-white px-5 py-2 rounded text-sm font-medium disabled:opacity-50"
            >
              追加
            </button>
          </div>

          {/* タイトルからカテゴリ検索 */}
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="タイトルからカテゴリを検索"
              value={searchTitle}
              onChange={(e) => setSearchTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <button
              onClick={handleSearch}
              className="border border-blue-300 text-blue-500 hover:bg-blue-50 px-4 py-2 rounded text-sm transition-colors"
            >
              カテゴリー予測
            </button>
          </div>

          {/* 検索結果テーブル */}
          <div className="border rounded mt-2">
            {searchResults.length === 0 && !searchTitle && (
              <div className="py-8 text-center text-sm text-gray-400">No data available</div>
            )}
            {searchResults.length === 0 && searchTitle && (
              <div className="py-8 text-center text-sm text-gray-400">該当するカテゴリがありません</div>
            )}
            {searchResults.map((cat, i) => {
              const registered = categories.find((c) => c.ebay_category_id === cat.id)
              return (
                <div
                  key={`${cat.id}-${i}`}
                  className="grid grid-cols-[100px_1fr_60px_80px] gap-3 px-4 py-3 border-b last:border-0 items-center text-sm"
                >
                  <span className="text-gray-600 font-mono text-xs">{cat.id}</span>
                  <span className="text-gray-800">{cat.name}</span>
                  <span className="text-gray-400 text-xs text-center">
                    {registered ? '登録済' : '0'}
                  </span>
                  <button
                    onClick={() => addCategory(cat.id, cat.name)}
                    disabled={!!registered}
                    className={`border rounded px-3 py-1 text-xs transition-colors ${
                      registered
                        ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                        : 'border-green-400 text-green-600 hover:bg-green-50'
                    }`}
                  >
                    {registered ? '登録済' : '適用'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'manage' && (
        <div className="border rounded">
          <div className="grid grid-cols-[100px_1fr_120px_130px_50px] gap-3 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
            <span>カテゴリID</span>
            <span>識別名</span>
            <span>商品状態の設定</span>
            <span></span>
            <span></span>
          </div>
          {categories.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">登録済みカテゴリがありません</div>
          ) : (
            categories.map((cat) => (
              <div key={cat.id} className="border-b last:border-0">
                <div className="grid grid-cols-[100px_1fr_120px_130px_50px] gap-3 px-4 py-3 items-center text-sm">
                  <span className="text-gray-600 font-mono text-xs">{cat.ebay_category_id}</span>
                  <span className="text-gray-700">{cat.name}</span>
                  <span className={`text-xs ${cat.condition_map ? 'text-green-600' : 'text-gray-400'}`}>
                    {cat.condition_map ? '設定済み' : '標準マッピング'}
                  </span>
                  <button
                    onClick={() => (editingId === cat.id ? setEditingId(null) : openConditionEditor(cat))}
                    className="text-xs border rounded px-2 py-1 text-gray-600 hover:bg-gray-50"
                  >
                    {editingId === cat.id ? '閉じる' : 'ConditionID設定'}
                  </button>
                  <button
                    onClick={() => handleDelete(cat.id)}
                    className="text-xs text-red-500 hover:text-red-700 text-right"
                  >
                    削除
                  </button>
                </div>

                {editingId === cat.id && (
                  <div className="px-4 pb-4 bg-gray-50 border-t">
                    <p className="text-xs text-gray-500 pt-3 pb-2">
                      eBayのConditionIDはカテゴリごとに有効な値が異なります
                      （例: CD・DVD等のメディア系カテゴリは 3000 / Used を受け付けません）。
                      このカテゴリで出品するときに、商品状態をどのConditionIDに変換するか設定します。
                    </p>

                    <div className="flex flex-wrap gap-2 pb-3">
                      <button
                        onClick={() => setDraftMap({ ...MEDIA_CONDITION_MAP })}
                        className="text-xs border rounded px-2.5 py-1 bg-white hover:bg-gray-100"
                      >
                        メディア系プリセット（CD・DVD・ゲーム）
                      </button>
                      <button
                        onClick={() => setDraftMap({ ...STANDARD_CONDITION_MAP })}
                        className="text-xs border rounded px-2.5 py-1 bg-white hover:bg-gray-100"
                      >
                        標準プリセット
                      </button>
                      {cat.condition_map && (
                        <button
                          onClick={() => clearConditionMap(cat.id)}
                          className="text-xs border rounded px-2.5 py-1 bg-white text-red-600 hover:bg-red-50"
                        >
                          設定を解除（標準に戻す）
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                      {CONDITION_GRADES.map((grade) => (
                        <label key={grade} className="flex items-center gap-2 text-xs">
                          <span className="w-32 shrink-0 text-gray-600">{grade}</span>
                          <select
                            value={draftMap[grade] ?? ''}
                            onChange={(e) => setDraftMap((prev) => ({ ...prev, [grade]: e.target.value }))}
                            className="flex-1 border rounded px-2 py-1 bg-white"
                          >
                            {EBAY_CONDITION_OPTIONS.map((opt) => (
                              <option key={opt.id} value={opt.id}>{opt.label}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>

                    <div className="flex justify-end gap-2 pt-3">
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-xs border rounded px-3 py-1.5 text-gray-600 bg-white hover:bg-gray-100"
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={() => saveConditionMap(cat.id)}
                        disabled={savingMap}
                        className="text-xs bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded px-3 py-1.5"
                      >
                        {savingMap ? '保存中...' : '設定を保存'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
