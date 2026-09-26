'use client'

// ユーザー要望(2026-09-25): 出品アカウント(出品セラー)を追加できるようにしたい。
// 抽出・CSV出品・ダイレクト出品で選ぶ「出品セラー」を、この画面で追加・編集・
// 既定設定・削除でき、eBayアカウントの接続もここから行える。
import { useCallback, useEffect, useState } from 'react'
import { Store } from 'lucide-react'

const SITES = ['US', 'UK', 'AU'] as const

interface SellerAccount {
  id: string
  seller_id: string
  display_name: string | null
  is_default: boolean
  ebay_user_id: string | null
  ebay_marketplace_id: string | null
  ebay_connected_at: string | null
  listing_site_ids: string[] | null
  created_at: string
}

export default function SellersPage() {
  const [sellers, setSellers] = useState<SellerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [newSellerId, setNewSellerId] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/seller-accounts')
    const json = await res.json()
    if (!res.ok) { setError(json.error ?? '読み込みに失敗しました'); setLoading(false); return }
    setSellers(json.sellers ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timeout)
  }, [load])

  // eBay接続から戻ってきたときの結果表示(?ebayConnected / ?ebayError)
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search)
      const connected = params.get('ebayConnected')
      const ebayError = params.get('ebayError')
      if (!connected && !ebayError) return
      if (connected) setNotice(`${connected} をeBayに接続しました。`)
      if (ebayError) setError(ebayError)
      params.delete('ebayConnected')
      params.delete('ebayError')
      const query = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [])

  function flash(message: string) {
    setNotice(message)
    setError('')
    setTimeout(() => setNotice(''), 4000)
  }

  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>) {
    setSaving(true)
    try {
      const res = await fetch('/api/seller-accounts', {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '処理に失敗しました')
      // 直前の失敗メッセージ(例: 出品サイトを0件にしようとした)を残さない
      setError('')
      await load()
      return json
    } catch (e) {
      setError(e instanceof Error ? e.message : '処理に失敗しました')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function addSeller() {
    const sellerId = newSellerId.trim()
    if (!sellerId) { setError('eBayのセラーIDを入力してください'); return }
    const result = await call('POST', { seller_id: sellerId, display_name: newDisplayName.trim() || null })
    if (result) {
      setNewSellerId(''); setNewDisplayName('')
      flash(`出品アカウント「${sellerId}」を追加しました`)
    }
  }

  async function toggleSite(seller: SellerAccount, site: string) {
    const current = seller.listing_site_ids ?? ['US']
    const next = current.includes(site) ? current.filter(s => s !== site) : [...current, site]
    if (next.length === 0) {
      // 先に追加したいサイトへチェックを入れてから外す、という順序を案内する
      setError(`${seller.seller_id} の出品サイトは1つ以上必要です。先に他のサイトにチェックを入れてから外してください`)
      return
    }
    await call('PATCH', { id: seller.id, listing_site_ids: next })
  }

  function connectEbay(sellerAccountId: string) {
    const params = new URLSearchParams({ returnTo: '/sellers', sellerAccountId })
    window.location.assign(`/api/ebay/oauth/start?${params.toString()}`)
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-900">出品アカウント</h1>
      <p className="mt-1 text-sm text-gray-500">
        抽出・CSV出品・ダイレクト出品で使う出品セラーを管理します。複数のeBayアカウントを登録して使い分けできます。
      </p>

      {error && <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {notice && <p className="mt-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</p>}

      {/* 追加 */}
      <div className="mt-6 max-w-3xl rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-800">出品アカウントを追加</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="relative">
            <label className="absolute -top-2 left-2 bg-white px-1 text-[10px] text-gray-400">eBayセラーID（必須）</label>
            <input value={newSellerId} onChange={e => setNewSellerId(e.target.value)} placeholder="例: miyabi-24"
              className="w-56 rounded border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
          </div>
          <div className="relative">
            <label className="absolute -top-2 left-2 bg-white px-1 text-[10px] text-gray-400">表示名（任意）</label>
            <input value={newDisplayName} onChange={e => setNewDisplayName(e.target.value)} placeholder="例: メイン / サブ"
              className="w-56 rounded border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
          </div>
          <button onClick={addSeller} disabled={saving}
            className="rounded border border-green-500 px-4 py-2 text-sm text-green-600 hover:bg-green-50 disabled:opacity-50">
            追加
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          セラーIDはeBayのユーザーID（出品画面に表示される名前）です。追加後に「eBayに接続」すると、ビジネスポリシーの自動取得とダイレクト出品・在庫管理が使えます。
          「出品サイト」はそのアカウントで出すサイトです（例: miyabi-24 は US、akebono-32 は UK/AU）。CSV出品のサイト選択がこの設定に合わせて初期表示されます。
        </p>
      </div>

      {/* 一覧 */}
      <div className="mt-6 max-w-5xl rounded-lg border border-gray-200 bg-white">
        <div className="grid grid-cols-[1fr_1fr_160px_100px_150px_190px] gap-3 border-b bg-gray-50 px-4 py-2 text-xs font-medium text-gray-500">
          <span>セラーID</span>
          <span>表示名</span>
          <span>出品サイト</span>
          <span>既定</span>
          <span>eBay接続</span>
          <span></span>
        </div>
        {loading ? (
          <div className="py-10 text-center text-sm text-gray-400">読み込み中...</div>
        ) : sellers.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">
            <Store className="mx-auto mb-2 text-gray-300" size={28} />
            出品アカウントがありません。上のフォームから追加してください。
          </div>
        ) : sellers.map(seller => (
          <div key={seller.id} className="grid grid-cols-[1fr_1fr_160px_100px_150px_190px] items-center gap-3 border-b px-4 py-3 text-sm last:border-0">
            <span className="font-mono text-gray-800">{seller.seller_id}</span>
            {editingId === seller.id ? (
              <input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)}
                className="rounded border px-2 py-1 text-sm" placeholder="表示名" />
            ) : (
              <span className="text-gray-600">{seller.display_name || '—'}</span>
            )}
            {/* このアカウントで出品するサイト。CSV出力のサイト選択の既定値になる */}
            <span className="flex gap-2 text-xs">
              {SITES.map(site => (
                <label key={site} className="flex items-center gap-1 text-gray-600">
                  <input
                    type="checkbox"
                    checked={(seller.listing_site_ids ?? ['US']).includes(site)}
                    onChange={() => toggleSite(seller, site)}
                    disabled={saving}
                  />
                  {site}
                </label>
              ))}
            </span>
            <span>
              {seller.is_default ? (
                <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">既定</span>
              ) : (
                <button onClick={() => call('PATCH', { id: seller.id, is_default: true })} disabled={saving}
                  className="text-xs text-blue-600 underline hover:text-blue-700 disabled:opacity-50">既定にする</button>
              )}
            </span>
            <span className="text-xs">
              {seller.ebay_connected_at
                ? <span className="text-green-600">接続済み{seller.ebay_user_id ? `（${seller.ebay_user_id}）` : ''}</span>
                : <span className="text-gray-400">未接続</span>}
            </span>
            <span className="flex flex-wrap justify-end gap-2">
              <button onClick={() => connectEbay(seller.id)}
                className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">
                {seller.ebay_connected_at ? '再接続' : 'eBayに接続'}
              </button>
              {editingId === seller.id ? (
                <button onClick={async () => { await call('PATCH', { id: seller.id, display_name: editDisplayName.trim() || null }); setEditingId(null) }}
                  disabled={saving} className="rounded border border-green-500 px-2 py-1 text-xs text-green-600 hover:bg-green-50 disabled:opacity-50">保存</button>
              ) : (
                <button onClick={() => { setEditingId(seller.id); setEditDisplayName(seller.display_name ?? '') }}
                  className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">編集</button>
              )}
              <button
                onClick={async () => {
                  if (!confirm(`「${seller.seller_id}」を削除しますか？（この出品セラーを使っている抽出がある場合は削除できません）`)) return
                  const result = await call('DELETE', { id: seller.id })
                  if (result) flash('出品アカウントを削除しました')
                }}
                disabled={saving}
                className="rounded border border-red-300 px-2 py-1 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50">削除</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
