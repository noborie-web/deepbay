'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
// 段階1は確実なASIN指定。段階2(2026-10-14)で検索URL・キーワードからASINを
// 探せるようにした。SP-APIの検索はAmazon.co.jpの検索結果と一致しないため、
// 検索結果をそのまま抽出に流さず、画面で選んでASIN欄に入れる形にしている。
interface SellerAccount { id: string; seller_id: string; display_name: string | null }
interface ListingCategory { id: string; ebay_category_id: string; name: string }
interface BulkEditSetting { id: string; name: string }
interface SearchItem { asin: string; title: string | null; brand: string | null }
interface SearchResult {
  items: SearchItem[]
  truncated: boolean
  warnings?: string[]
  query?: { keywords: string[]; brandNames: string[]; classificationIds: string[] }
}

const MAX_ASINS = 300

export default function AmazonExtractionPage() {
  const router = useRouter()
  const supabase = createClient()

  const [asinText, setAsinText] = useState('')
  const [fbaOnly, setFbaOnly] = useState(true)
  // 段階2: 検索URL・キーワードからASINを探す
  const [searchQuery, setSearchQuery] = useState('')
  const [searchLimit, setSearchLimit] = useState(100)
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [selectedAsins, setSelectedAsins] = useState<Set<string>>(new Set())
  const [searchError, setSearchError] = useState<string | null>(null)
  const [memo, setMemo] = useState('')
  const [sellerAccountId, setSellerAccountId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [bulkEditSettingId, setBulkEditSettingId] = useState('')
  const [connected, setConnected] = useState<boolean | null>(null)
  const [sellers, setSellers] = useState<SellerAccount[]>([])
  const [categories, setCategories] = useState<ListingCategory[]>([])
  const [bulkSettings, setBulkSettings] = useState<BulkEditSetting[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // 入力の見積もり。実効2 ASIN/s なので、件数から所要時間が読める
  const parsed = asinText
    .split(/[\s,"']+/)
    .map(t => t.trim().toUpperCase())
    .map(t => t.match(/(?:\/DP\/|\/GP\/PRODUCT\/)([A-Z0-9]{10})/)?.[1] ?? t)
    .filter(t => /^[A-Z0-9]{10}$/.test(t))
  const uniqueCount = new Set(parsed).size
  const estimatedSec = Math.ceil(uniqueCount / 2)

  const load = useCallback(async () => {
    const [{ data: sellerRows }, { data: categoryRows }, { data: bulkRows }] = await Promise.all([
      supabase.from('seller_accounts').select('id, seller_id, display_name').order('created_at'),
      supabase.from('listing_categories').select('id, ebay_category_id, name').order('name'),
      supabase.from('bulk_edit_settings').select('id, name').order('created_at'),
    ])
    setSellers((sellerRows ?? []) as SellerAccount[])
    setCategories((categoryRows ?? []) as ListingCategory[])
    setBulkSettings((bulkRows ?? []) as BulkEditSetting[])

    try {
      const res = await fetch('/api/amazon/credentials', { cache: 'no-store' })
      const json = await res.json() as { connected?: boolean }
      setConnected(Boolean(json.connected))
    } catch {
      setConnected(null)
    }
  }, [supabase])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const runSearch = async () => {
    setSearching(true)
    setSearchError(null)
    setSearchResult(null)
    try {
      const res = await fetch('/api/amazon/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery, limit: searchLimit }),
      })
      const json = await res.json() as SearchResult & { error?: string }
      if (!res.ok) throw new Error(json.error ?? '検索できませんでした')
      setSearchResult(json)
      // 既にASIN欄にある分は選択から外す(入れ直しても重複は除かれるが、
      // 画面上でも「これから足す分」が分かるようにする)
      const already = new Set(parsed)
      setSelectedAsins(new Set(json.items.map(i => i.asin).filter(a => !already.has(a))))
      if (json.items.length === 0) setSearchError('該当する商品が見つかりませんでした')
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : 'エラーが発生しました')
    } finally {
      setSearching(false)
    }
  }

  const toggleAsin = (asin: string) => {
    setSelectedAsins(prev => {
      const next = new Set(prev)
      if (next.has(asin)) next.delete(asin)
      else next.add(asin)
      return next
    })
  }

  const addSelectedToAsinList = () => {
    const picked = (searchResult?.items ?? [])
      .map(i => i.asin)
      .filter(a => selectedAsins.has(a))
    if (picked.length === 0) return
    // 重複は入力欄の時点で除く(抽出側でも除かれるが、件数表示を正しくする)
    const existing = new Set(parsed)
    const added = picked.filter(a => !existing.has(a))
    setAsinText(prev => [prev.trim(), ...added].filter(Boolean).join('\n'))
    setSelectedAsins(new Set())
  }

  const submit = async () => {
    setSubmitting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/extract/amazon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asins: asinText,
          fbaOnly,
          memo,
          sellerAccountId: sellerAccountId || null,
          categoryId: categoryId || null,
          bulkEditSettingId: bulkEditSettingId || null,
        }),
      })
      const json = await res.json() as { error?: string; asinCount?: number; invalid?: string[] }
      if (!res.ok) throw new Error(json.error ?? '抽出を開始できませんでした')
      setMessage({
        type: 'success',
        text: `${json.asinCount}件のASINで抽出を開始しました`
          + (json.invalid?.length ? `（読み取れなかった値: ${json.invalid.length}件）` : ''),
      })
      setAsinText('')
      window.setTimeout(() => router.push('/extraction'), 1200)
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'エラーが発生しました' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-bold">Amazon抽出</h1>
        <p className="mt-1 text-sm text-gray-500">
          Amazon.co.jpの新品を取り込みます。ASINを直接入力するか、検索URL・キーワードから
          ASINを探して選べます。取り込んだあとは他の仕入先と同じで、
          翻訳・価格の自動計算・除外条件・重複判定がそのまま適用されます。
        </p>
      </div>

      {connected === false && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Amazonと接続されていません。
          <a href="/extraction-settings" className="ml-1 underline">抽出設定 → 仕入先連携</a>
          で接続してください。
        </div>
      )}

      {/* 段階2: 検索URL・キーワードからASINを探す */}
      <div className="rounded-lg border bg-white p-5 space-y-3">
        <div>
          <h2 className="text-sm font-medium text-gray-700">検索URL・キーワードからASINを探す</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Amazonの検索URLを貼るか、キーワードを入力してください。URLの
            <code className="mx-1 rounded bg-gray-100 px-1">k</code>（キーワード）・
            <code className="mx-1 rounded bg-gray-100 px-1">node</code>／
            <code className="mx-1 rounded bg-gray-100 px-1">rh=n:</code>（カテゴリ）・
            <code className="mx-1 rounded bg-gray-100 px-1">rh=p_89:</code>（ブランド）を読み取ります。
          </p>
          <p className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            この検索はAmazonの商品カタログ（SP-API）を検索するもので、
            <strong>Amazon.co.jpの検索結果ページとは並び順も件数も一致しません</strong>。
            サイトと同じ並びで取ることはできないため、取れたASINを下の一覧で確認してから抽出に渡してください。
            カテゴリ・ブランドだけでは検索できず、キーワードが必要です。
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[18rem] flex-1 text-xs text-gray-600">
            検索URL / キーワード
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && searchQuery.trim() && !searching) void runSearch() }}
              placeholder="https://www.amazon.co.jp/s?k=casio+watch&node=2017157051　または　casio 腕時計"
              className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm"
            />
          </label>
          <label className="text-xs text-gray-600">
            取得件数
            <select value={searchLimit} onChange={e => setSearchLimit(Number(e.target.value))}
              className="mt-0.5 block w-24 rounded border bg-white px-2 py-1.5 text-sm">
              {[20, 50, 100, 200, 300].map(n => <option key={n} value={n}>{n}件</option>)}
            </select>
          </label>
          <button
            onClick={() => void runSearch()}
            disabled={searching || !searchQuery.trim() || connected === false}
            className="rounded border border-blue-600 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-40"
          >
            {searching ? '検索しています...' : 'ASINを検索'}
          </button>
        </div>

        {searchError && <p className="text-xs text-red-600">{searchError}</p>}
        {searchResult?.warnings?.map(w => (
          <p key={w} className="text-xs text-amber-700">{w}</p>
        ))}

        {searchResult && searchResult.items.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
              <span>
                {searchResult.items.length}件見つかりました
                {searchResult.truncated && '（上限に達したため、これ以上は取得していません）'}
                ・選択中 <strong className="text-gray-900">{selectedAsins.size}</strong>件
              </span>
              <button
                onClick={() => setSelectedAsins(new Set(searchResult.items.map(i => i.asin)))}
                className="underline hover:text-gray-900"
              >
                すべて選ぶ
              </button>
              <button onClick={() => setSelectedAsins(new Set())} className="underline hover:text-gray-900">
                選択を外す
              </button>
              <button
                onClick={addSelectedToAsinList}
                disabled={selectedAsins.size === 0}
                className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700 disabled:opacity-40"
              >
                選んだ{selectedAsins.size}件をASIN欄に入れる
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto rounded border">
              <table className="w-full text-xs">
                <tbody>
                  {searchResult.items.map(item => (
                    <tr key={item.asin} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="w-8 px-2 py-1.5 align-top">
                        <input
                          type="checkbox"
                          checked={selectedAsins.has(item.asin)}
                          onChange={() => toggleAsin(item.asin)}
                        />
                      </td>
                      <td className="w-28 px-2 py-1.5 align-top font-mono text-gray-700">
                        <a
                          href={`https://www.amazon.co.jp/dp/${item.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-blue-700"
                        >
                          {item.asin}
                        </a>
                      </td>
                      <td className="px-2 py-1.5 align-top text-gray-800">
                        {item.title ?? <span className="text-gray-400">（商品名なし）</span>}
                        {item.brand && <span className="ml-1 text-gray-500">／{item.brand}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">
              価格・在庫はここでは取得していません（抽出のときに取得します）。
              新品の出品が無い商品は抽出時に除外されます。
            </p>
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-white p-5 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">ASIN</span>
          <p className="mt-0.5 text-xs text-gray-500">
            改行・カンマ・タブ区切りで入力できます。Amazonの商品URLを貼っても構いません。
            重複は自動で取り除きます。1回に{MAX_ASINS}件までです。
          </p>
          <textarea
            value={asinText}
            onChange={e => setAsinText(e.target.value)}
            rows={12}
            placeholder={'B0F18J2CJF\nB00ABCDEFG\nhttps://www.amazon.co.jp/dp/B01ZZZZZZZ'}
            className="mt-1.5 w-full rounded border px-3 py-2 font-mono text-sm"
          />
          <span className="mt-1 block text-xs text-gray-500">
            読み取れたASIN: <strong className={uniqueCount > MAX_ASINS ? 'text-red-600' : 'text-gray-900'}>{uniqueCount}</strong>件
            {uniqueCount > 0 && `（取得にかかる目安: 約${estimatedSec}秒）`}
            {uniqueCount > MAX_ASINS && ` — ${MAX_ASINS}件までに分けてください`}
          </span>
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={fbaOnly} onChange={e => setFbaOnly(e.target.checked)} />
          FBA（Amazon発送）の出品だけを対象にする
        </label>
        <p className="-mt-2 text-xs text-gray-500">
          外すと自社発送の出品も対象になり、より安い価格を拾えますが、発送が遅い出品者が混ざります。
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-xs text-gray-600">
            出品セラー
            <select value={sellerAccountId} onChange={e => setSellerAccountId(e.target.value)}
              className="mt-0.5 w-full rounded border bg-white px-2 py-1.5 text-sm">
              <option value="">指定しない</option>
              {sellers.map(s => (
                <option key={s.id} value={s.id}>{s.display_name?.trim() || s.seller_id}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-gray-600">
            出品カテゴリ
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)}
              className="mt-0.5 w-full rounded border bg-white px-2 py-1.5 text-sm">
              <option value="">指定しない</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.name}（{c.ebay_category_id}）</option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-gray-600">
            一括編集設定
            <select value={bulkEditSettingId} onChange={e => setBulkEditSettingId(e.target.value)}
              className="mt-0.5 w-full rounded border bg-white px-2 py-1.5 text-sm">
              <option value="">指定しない</option>
              {bulkSettings.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        </div>

        <label className="block text-xs text-gray-600">
          メモ
          <input value={memo} onChange={e => setMemo(e.target.value)}
            placeholder="抽出リスト名など"
            className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm" />
        </label>

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={submit}
            disabled={submitting || uniqueCount === 0 || uniqueCount > MAX_ASINS || connected === false}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {submitting ? '開始しています...' : '抽出を開始'}
          </button>
          {message && (
            <span className={`text-xs ${message.type === 'success' ? 'text-green-700' : 'text-red-600'}`}>
              {message.text}
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-400">
        新品の出品が無いASIN・価格を取得できなかったASINは取り込まれません。
        件数は抽出結果の「除外詳細」で確認できます。
      </p>
    </div>
  )
}
