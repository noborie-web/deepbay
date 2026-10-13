'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
// Amazonは検索URLからの取得がサイト側と一致しないため、まず確実なASIN指定から作る。
interface SellerAccount { id: string; seller_id: string; display_name: string | null }
interface ListingCategory { id: string; ebay_category_id: string; name: string }
interface BulkEditSetting { id: string; name: string }

const MAX_ASINS = 300

export default function AmazonExtractionPage() {
  const router = useRouter()
  const supabase = createClient()

  const [asinText, setAsinText] = useState('')
  const [fbaOnly, setFbaOnly] = useState(true)
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
        <h1 className="text-xl font-bold">Amazon抽出（ASIN指定）</h1>
        <p className="mt-1 text-sm text-gray-500">
          Amazon.co.jpの新品をASINで取り込みます。取り込んだあとは他の仕入先と同じで、
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
