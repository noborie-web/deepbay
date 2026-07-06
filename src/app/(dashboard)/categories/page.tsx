'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { EBAY_CATEGORIES } from '@/data/ebay-categories'
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

  const supabase = createClient()

  useEffect(() => {
    fetchCategories()
  }, [])

  async function fetchCategories() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from('listing_categories')
      .select('*')
      .order('sort_order', { ascending: true })
    setCategories(data ?? [])
  }

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
          <div className="grid grid-cols-[100px_1fr_80px] gap-3 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
            <span>カテゴリID</span>
            <span>識別名</span>
            <span></span>
          </div>
          {categories.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">登録済みカテゴリがありません</div>
          ) : (
            categories.map((cat) => (
              <div key={cat.id} className="grid grid-cols-[100px_1fr_80px] gap-3 px-4 py-3 border-b last:border-0 items-center text-sm">
                <span className="text-gray-600 font-mono text-xs">{cat.ebay_category_id}</span>
                <span className="text-gray-700">{cat.name}</span>
                <button
                  onClick={() => handleDelete(cat.id)}
                  className="text-xs text-red-500 hover:text-red-700 text-right"
                >
                  削除
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
