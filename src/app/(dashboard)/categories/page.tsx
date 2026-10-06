'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { EBAY_CATEGORIES } from '@/data/ebay-categories'
import {
  CONDITION_GRADE_GROUPS,
  EBAY_CONDITION_OPTIONS,
  MEDIA_CONDITION_MAP,
  STANDARD_CONDITION_MAP,
  conditionTone,
} from '@/lib/listing-export'
import type { ConditionTone } from '@/lib/listing-export'
import type { ListingCategory } from '@/types/database'

// ConditionIDの区分ごとの色。新品系を中古系と取り違えていないかを
// 目で確認できるようにする。
const TONE_SELECT: Record<ConditionTone, string> = {
  new: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  likeNew: 'border-sky-300 bg-sky-50 text-sky-900',
  used: 'border-amber-300 bg-amber-50 text-amber-900',
  poor: 'border-rose-300 bg-rose-50 text-rose-900',
}

const TONE_SWATCH: Record<ConditionTone, string> = {
  new: 'border-emerald-300 bg-emerald-100',
  likeNew: 'border-sky-300 bg-sky-100',
  used: 'border-amber-300 bg-amber-100',
  poor: 'border-rose-300 bg-rose-100',
}

const CONDITION_TONE_LEGEND: { tone: ConditionTone; label: string }[] = [
  { tone: 'new', label: '新品 (1000・1500・1750)' },
  { tone: 'likeNew', label: '未使用に近い・整備済 (2000・2500・2750)' },
  { tone: 'used', label: '中古 (3000・4000・5000)' },
  { tone: 'poor', label: '可・ジャンク (6000・7000)' },
]

interface EbayCategory { id: string; name: string; level?: number; is_leaf?: boolean }

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
  // 変換表に無い商品状態(空・仕入先の想定外の文字列)のときに使うConditionID。
  // '' は未設定で、従来どおり 3000 (Used) になる。
  const [draftDefaultId, setDraftDefaultId] = useState<string>('')
  const [savingMap, setSavingMap] = useState(false)

  const [supabase] = useState(createClient)

  // 本番で確認した不具合(2026-09-23): すでに登録済みの親カテゴリ(例: 222 / 966 /
  // 13999)は一覧から見分けられず、CSV出力して初めてエラーになっていた。
  // 登録済み一覧でも親カテゴリを警告表示する。
  const [parentCategoryIds, setParentCategoryIds] = useState<Set<string>>(new Set())
  const markParentCategories = useCallback((list: ListingCategory[]) => {
    if (list.length === 0) return Promise.resolve(new Set<string>())
    return Promise.all(list.map(async (c) => {
      if (!c.ebay_category_id) return null
      const { isLeaf } = await checkLeaf(c.ebay_category_id)
      return isLeaf ? null : c.ebay_category_id
    })).then(results => new Set(results.filter((id): id is string => id !== null)))
  }, [])

  const loadCategories = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from('listing_categories')
      .select('*')
      .order('sort_order', { ascending: true })
    return (data ?? []) as ListingCategory[]
  }, [supabase])

  const fetchCategories = useCallback(async () => {
    const data = await loadCategories()
    setCategories(data)
    setParentCategoryIds(await markParentCategories(data))
  }, [loadCategories, markParentCategories])

  useEffect(() => {
    let active = true
    void loadCategories().then(async (data) => {
      if (!active) return
      setCategories(data)
      const parents = await markParentCategories(data)
      if (active) setParentCategoryIds(parents)
    })
    return () => { active = false }
  }, [loadCategories, markParentCategories])

  // 本番で確認した不具合(2026-09-23): すでに登録済みの親カテゴリ(例: 222 / 966 /
  // 13999)は一覧からは見分けられず、CSV出力して初めてエラーになっていた。
  // 登録済み一覧でも親カテゴリを警告表示する。
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

  // 本番で確認した不具合(2026-09-23): 親カテゴリ(例: 222 Diecast & Toy Vehicles)を
  // 登録してCSV出品すると、eBayが「The category selected is not a leaf category.」で
  // 全件エラーにする。登録時に末端カテゴリかどうかを確認し、親なら子を選ばせる。
  async function checkLeaf(ebayId: string): Promise<{ isLeaf: boolean; children: EbayCategory[] }> {
    try {
      const res = await fetch(`/api/ebay-categories?mode=children&parent=${encodeURIComponent(ebayId)}`)
      if (!res.ok) return { isLeaf: true, children: [] }
      const children = await res.json()
      return { isLeaf: !Array.isArray(children) || children.length === 0, children: Array.isArray(children) ? children : [] }
    } catch {
      return { isLeaf: true, children: [] }
    }
  }

  async function addCategory(ebayId: string, name: string) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { isLeaf, children } = await checkLeaf(ebayId)
    if (!isLeaf) {
      setError(`「${name}」(${ebayId})は親カテゴリのため、eBayに出品できません（The category selected is not a leaf category.）。下の候補から末端カテゴリを選んでください。`)
      setSearchResults(children)
      setSuccessMsg('')
      return
    }

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
      setError('')
      setSuccessMsg(`「${name}」を追加しました`)
      setTimeout(() => setSuccessMsg(''), 3000)
      fetchCategories()
    }
  }

  async function showChildren(parentId: string) {
    const { children } = await checkLeaf(parentId)
    if (children.length > 0) { setSearchResults(children); setError('') }
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

  // 本番で確認した不具合(2026-09-26): 親カテゴリ222を削除しようとしても何も
  // 起きなかった。その抽出が参照しているため外部キー制約で拒否されるのに、
  // エラーを捨てていたので画面に何も出ていなかった。理由を必ず表示する。
  async function handleDelete(id: string) {
    if (!confirm('このカテゴリを削除しますか？')) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: err } = await (supabase as any).from('listing_categories').delete().eq('id', id)
    if (err) {
      const inUse = err.code === '23503' || /foreign key/i.test(err.message ?? '')
      setSuccessMsg('')
      setError(inUse
        ? 'このカテゴリーを使っている抽出があるため削除できません。カテゴリーIDを末端カテゴリーに変更すれば、その抽出もそのまま出品できます（右の「IDを変更」）。'
        : `削除できませんでした: ${err.message ?? '不明なエラー'}`)
      return
    }
    setError('')
    setSuccessMsg('カテゴリーを削除しました')
    setTimeout(() => setSuccessMsg(''), 3000)
    fetchCategories()
  }

  // 親カテゴリを登録してしまった場合に、削除せず末端カテゴリへ付け替える。
  // 抽出が参照していても、その抽出のCSVをそのまま出せるようになる。
  async function repointCategory(cat: ListingCategory) {
    const nextId = window.prompt(
      `「${cat.name}」の eBayカテゴリーID を変更します。\n末端カテゴリーのIDを入力してください（親カテゴリーは登録できません）。`,
      cat.ebay_category_id ?? '',
    )
    if (nextId === null) return
    const trimmed = nextId.trim()
    if (!trimmed || trimmed === cat.ebay_category_id) return

    const { isLeaf, children } = await checkLeaf(trimmed)
    if (!isLeaf) {
      setSuccessMsg('')
      setError(`${trimmed} は親カテゴリのため出品できません。下の候補から末端カテゴリを選んでください。`)
      setSearchResults(children)
      setTab('add')
      return
    }
    if (categories.some(c => c.id !== cat.id && c.ebay_category_id === trimmed)) {
      setSuccessMsg('')
      setError(`${trimmed} はすでに別の行で登録済みです`)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: err } = await (supabase as any)
      .from('listing_categories')
      .update({ ebay_category_id: trimmed })
      .eq('id', cat.id)
    if (err) {
      setSuccessMsg('')
      setError(`カテゴリーIDを変更できませんでした: ${err.message ?? '不明なエラー'}`)
      return
    }
    setError('')
    setSuccessMsg(`「${cat.name}」のカテゴリーIDを ${trimmed} に変更しました`)
    setTimeout(() => setSuccessMsg(''), 4000)
    fetchCategories()
  }

  // ---- 商品状態→ConditionIDのカテゴリー別設定 ----
  // eBayのConditionIDはカテゴリごとに有効な値が違い、例えばCD(176984)は
  // 3000(Used)を受け付けずアップロードが全件失敗する。カテゴリ単位で
  // 対応表を設定できるようにする。
  function openConditionEditor(cat: ListingCategory) {
    setEditingId(cat.id)
    setDraftMap({ ...STANDARD_CONDITION_MAP, ...(cat.condition_map ?? {}) })
    setDraftDefaultId(cat.default_condition_id ?? '')
  }

  async function saveConditionMap(id: string) {
    setSavingMap(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: err } = await (supabase as any)
      .from('listing_categories')
      .update({ condition_map: draftMap, default_condition_id: draftDefaultId || null })
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
    await (supabase as any).from('listing_categories').update({ condition_map: null, default_condition_id: null }).eq('id', id)
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

      {/* 削除・ID変更は「登録済みカテゴリー管理」タブで行うため、エラーは
          タブに関係なく表示する(本番で削除の失敗理由が見えなかったため) */}
      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}

      {tab === 'add' && (
        <div className="space-y-4">

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
                  <span className="text-gray-800">
                    {cat.name}
                    {cat.is_leaf === false && (
                      <button onClick={() => showChildren(cat.id)}
                        className="ml-2 text-xs text-orange-600 underline hover:text-orange-700">
                        親カテゴリ（出品不可）→ 下位を表示
                      </button>
                    )}
                  </span>
                  <span className="text-gray-400 text-xs text-center">
                    {registered ? '登録済' : '0'}
                  </span>
                  <button
                    onClick={() => addCategory(cat.id, cat.name)}
                    disabled={!!registered || cat.is_leaf === false}
                    className={`border rounded px-3 py-1 text-xs transition-colors ${
                      registered || cat.is_leaf === false
                        ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                        : 'border-green-400 text-green-600 hover:bg-green-50'
                    }`}
                  >
                    {registered ? '登録済' : cat.is_leaf === false ? '出品不可' : '適用'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'manage' && (
        <div className="border rounded">
          <div className="grid grid-cols-[100px_1fr_120px_130px_90px_50px] gap-3 px-4 py-2 bg-gray-50 border-b text-xs font-medium text-gray-500">
            <span>カテゴリID</span>
            <span>識別名</span>
            <span>商品状態の設定</span>
            <span></span>
            <span></span>
            <span></span>
          </div>
          {categories.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">登録済みカテゴリがありません</div>
          ) : (
            categories.map((cat) => (
              <div key={cat.id} className="border-b last:border-0">
                <div className="grid grid-cols-[100px_1fr_120px_130px_90px_50px] gap-3 px-4 py-3 items-center text-sm">
                  <span className="text-gray-600 font-mono text-xs">{cat.ebay_category_id}</span>
                  <span className="text-gray-700">
                    {cat.name}
                    {cat.ebay_category_id && parentCategoryIds.has(cat.ebay_category_id) && (
                      <button onClick={() => { setTab('add'); showChildren(cat.ebay_category_id!) }}
                        className="ml-2 text-xs text-red-600 underline hover:text-red-700">
                        ⚠ 親カテゴリ・出品不可 → 下位を選ぶ
                      </button>
                    )}
                  </span>
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
                    onClick={() => repointCategory(cat)}
                    className="text-xs border rounded px-2 py-1 text-gray-600 hover:bg-gray-50"
                    title="親カテゴリを登録してしまった場合に、末端カテゴリへ付け替えます"
                  >
                    IDを変更
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
                        onClick={() => { setDraftMap({ ...MEDIA_CONDITION_MAP }); setDraftDefaultId('5000') }}
                        className="text-xs border rounded px-2.5 py-1 bg-white hover:bg-gray-100"
                      >
                        メディア系プリセット（CD・DVD・ゲーム）
                      </button>
                      <button
                        onClick={() => { setDraftMap({ ...STANDARD_CONDITION_MAP }); setDraftDefaultId('') }}
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

                    {/* ユーザー要望(2026-10-05): 1行に2組並べていたため文字が
                        重なって読めなかった。「左=仕入先の状態 / 右=eBayの
                        ConditionID」の対応が一目で分かるように1列に並べ、
                        ConditionIDの区分を色分けする。 */}
                    <div className="flex items-center justify-between pb-1.5 text-[11px] font-medium text-gray-500">
                      <span>仕入先・アプリ上の商品状態</span>
                      <span>eBayのConditionID</span>
                    </div>

                    <div className="flex flex-wrap gap-x-3 gap-y-1 pb-2.5 text-[11px] text-gray-500">
                      {CONDITION_TONE_LEGEND.map(({ tone, label }) => (
                        <span key={tone} className="flex items-center gap-1">
                          <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${TONE_SWATCH[tone]}`} />
                          {label}
                        </span>
                      ))}
                    </div>

                    <div className="space-y-3">
                      {CONDITION_GRADE_GROUPS.map((group) => (
                        <div key={group.label} className="rounded border bg-white">
                          <div className="border-b px-3 py-1.5">
                            <span className="text-xs font-medium text-gray-700">{group.label}</span>
                            <span className="pl-2 text-[11px] text-gray-400">{group.note}</span>
                          </div>
                          <div className="divide-y">
                            {group.grades.map((grade) => {
                              const selected = draftMap[grade] ?? ''
                              const tone = selected ? conditionTone(selected) : null
                              return (
                                <label key={grade} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                                  <span className="w-40 shrink-0 text-gray-700">{grade}</span>
                                  <span aria-hidden className="shrink-0 text-gray-300">→</span>
                                  <select
                                    value={selected}
                                    onChange={(e) => setDraftMap((prev) => ({ ...prev, [grade]: e.target.value }))}
                                    className={`min-w-0 flex-1 rounded border px-2 py-1 ${tone ? TONE_SELECT[tone] : 'border-gray-300 bg-white'}`}
                                  >
                                    {EBAY_CONDITION_OPTIONS.map((opt) => (
                                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                                    ))}
                                  </select>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* ユーザー要望(2026-10-06): 商品状態が空、または仕入先が
                        想定外の文字列を返した商品は変換表にキーが無く、既定の
                        3000 (Used) に落ちてCD等では出品が失敗する。カテゴリごとに
                        その場合のConditionIDを決められるようにする。 */}
                    <div className="mt-3 rounded border bg-white px-3 py-2">
                      <label className="flex items-center gap-2 text-xs">
                        <span className="w-40 shrink-0 text-gray-700">上記以外・状態が空の場合</span>
                        <span aria-hidden className="shrink-0 text-gray-300">→</span>
                        <select
                          value={draftDefaultId}
                          onChange={(e) => setDraftDefaultId(e.target.value)}
                          className={`min-w-0 flex-1 rounded border px-2 py-1 ${draftDefaultId ? TONE_SELECT[conditionTone(draftDefaultId)] : 'border-gray-300 bg-white'}`}
                        >
                          <option value="">指定なし（3000 / Used になります）</option>
                          {EBAY_CONDITION_OPTIONS.map((opt) => (
                            <option key={opt.id} value={opt.id}>{opt.label}</option>
                          ))}
                        </select>
                      </label>
                      <p className="pt-1.5 text-[11px] text-gray-400">
                        仕入先から商品状態を取得できなかった商品や、ヤフオク等の自由文の状態が入っている商品に使われます。
                      </p>
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
