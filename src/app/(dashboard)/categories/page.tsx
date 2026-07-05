'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ListingCategory } from '@/types/database'

export default function CategoriesPage() {
  const [tab, setTab] = useState<'add' | 'manage'>('add')
  const [categoryId, setCategoryId] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [searchTitle, setSearchTitle] = useState('')
  const [categories, setCategories] = useState<ListingCategory[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const supabase = createClient()

  useEffect(() => {
    fetchCategories()
  }, [])

  async function fetchCategories() {
    const { data } = await supabase
      .from('listing_categories')
      .select('*')
      .order('sort_order', { ascending: true })
    setCategories(data ?? [])
  }

  async function handleAdd() {
    if (!categoryId.trim() || !categoryName.trim()) {
      setError('カテゴリIDと識別名は必須です')
      return
    }
    setError('')
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: err } = await (supabase as any).from('listing_categories').insert({
      user_id: user.id,
      ebay_category_id: categoryId.trim(),
      name: categoryName.trim(),
      sort_order: categories.length,
    })
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    setCategoryId('')
    setCategoryName('')
    fetchCategories()
  }

  async function handleDelete(id: string) {
    if (!confirm('このカテゴリを削除しますか？')) return
    await supabase.from('listing_categories').delete().eq('id', id)
    fetchCategories()
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-bold mb-6">出品カテゴリー管理</h1>

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

      {tab === 'add' && (
        <div className="space-y-4">
          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* カテゴリ追加フォーム */}
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
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <button
              disabled
              className="border border-blue-300 text-blue-400 px-4 py-2 rounded text-sm cursor-not-allowed"
            >
              カテゴリー予測
            </button>
          </div>

          {/* カテゴリ一覧テーブル */}
          <div className="border rounded mt-4">
            <div className="grid grid-cols-[1fr_1fr_80px] gap-3 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
              <span>カテゴリID</span>
              <span>識別名</span>
              <span></span>
            </div>
            {categories.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">No data available</div>
            ) : (
              categories.map((cat) => (
                <div key={cat.id} className="grid grid-cols-[1fr_1fr_80px] gap-3 px-4 py-3 border-b last:border-0 items-center text-sm">
                  <span className="text-gray-700">{cat.ebay_category_id}</span>
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
        </div>
      )}

      {tab === 'manage' && (
        <div className="space-y-3">
          {categories.length === 0 ? (
            <p className="text-sm text-gray-400 py-8 text-center">登録済みカテゴリがありません</p>
          ) : (
            categories.map((cat) => (
              <div key={cat.id} className="flex items-center justify-between border rounded px-4 py-3 text-sm">
                <div>
                  <span className="font-medium">{cat.name}</span>
                  <span className="text-gray-400 ml-3 text-xs">ID: {cat.ebay_category_id}</span>
                </div>
                <button
                  onClick={() => handleDelete(cat.id)}
                  className="text-xs text-red-500 hover:text-red-700"
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
