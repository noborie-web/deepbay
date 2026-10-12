'use client'

import { useCallback, useEffect, useState } from 'react'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
// Amazonはbot対策が強くスクレイピングが安定しないため、SP-APIを使う。
// その認証情報(LWA)を保存する画面。秘密情報は保存時に暗号化され、
// 画面には伏せ字でしか戻さない。
interface Status {
  connected: boolean
  client_id_masked?: string
  marketplace_id?: string
  verified_at?: string | null
  last_error?: string | null
}

const MARKETPLACES: { id: string; label: string }[] = [
  { id: 'A1VC38T7YXB528', label: '日本 (amazon.co.jp)' },
]

export default function AmazonConnectionPanel() {
  const [status, setStatus] = useState<Status | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [marketplaceId, setMarketplaceId] = useState(MARKETPLACES[0].id)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/amazon/credentials', { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json() as Status
      // await をはさんでから更新する(effectから同期的にsetStateしない)
      setStatus(json)
      setMarketplaceId((prev) => json.marketplace_id ?? prev)
    } catch {
      // 取得できなくても入力はできる
    }
  }, [])

  // 初回だけ読み込む。effectから同期的にsetStateしないよう、1tick遅らせる
  // (InventoryPanelの読み込みと同じ書き方)
  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/amazon/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, refreshToken, marketplaceId }),
      })
      const json = await res.json() as { error?: string }
      if (!res.ok) throw new Error(json.error ?? '保存できませんでした')
      // 保存できた=実際に認証が通った。入力欄は残さない
      setClientId(''); setClientSecret(''); setRefreshToken('')
      setMessage({ type: 'success', text: 'Amazonに接続しました（認証を確認済み）' })
      await load()
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : 'エラーが発生しました' })
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    if (!confirm('Amazonの接続を解除しますか？\n保存されている認証情報は削除されます。')) return
    setSaving(true)
    try {
      await fetch('/api/amazon/credentials', { method: 'DELETE' })
      setMessage({ type: 'success', text: '接続を解除しました' })
      await load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">Amazon（仕入先）との接続</h3>
        <p className="mt-1 text-xs text-gray-500">
          Amazon.co.jpの商品をASINで取り込むために、SP-APIの認証情報を登録します。
          Amazonは自動アクセスの制限が厳しいため、商品ページの読み取りではなく公式APIを使います。
          入力した情報は暗号化して保存され、画面には伏せ字でしか表示されません。
        </p>
      </div>

      {status?.connected ? (
        <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">
          <p className="font-medium">接続済み</p>
          <p className="mt-1">クライアントID: {status.client_id_masked}</p>
          <p>マーケットプレイス: {MARKETPLACES.find(m => m.id === status.marketplace_id)?.label ?? status.marketplace_id}</p>
          {status.verified_at && (
            <p>最終確認: {new Date(status.verified_at).toLocaleString('ja-JP')}</p>
          )}
          {status.last_error && <p className="mt-1 text-red-700">前回のエラー: {status.last_error}</p>}
        </div>
      ) : (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          まだ接続されていません。
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-xs text-gray-600">
          クライアントID（LWA）
          <input value={clientId} onChange={e => setClientId(e.target.value)}
            placeholder="amzn1.application-oa2-client..."
            className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm" />
        </label>
        <label className="block text-xs text-gray-600">
          クライアントシークレット
          <input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)}
            placeholder="amzn1.oa2-cs.v1..."
            className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm" />
        </label>
        <label className="block text-xs text-gray-600">
          リフレッシュトークン
          <input type="password" value={refreshToken} onChange={e => setRefreshToken(e.target.value)}
            placeholder="Atzr|..."
            className="mt-0.5 w-full rounded border px-2 py-1.5 text-sm" />
        </label>
        <label className="block text-xs text-gray-600">
          マーケットプレイス
          <select value={marketplaceId} onChange={e => setMarketplaceId(e.target.value)}
            className="mt-0.5 w-full rounded border bg-white px-2 py-1.5 text-sm">
            {MARKETPLACES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !clientId.trim() || !clientSecret.trim() || !refreshToken.trim()}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? '確認中...' : status?.connected ? '保存して再接続' : '接続する'}
        </button>
        {status?.connected && (
          <button onClick={disconnect} disabled={saving}
            className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40">
            接続を解除
          </button>
        )}
        {message && (
          <span className={`text-xs ${message.type === 'success' ? 'text-green-700' : 'text-red-600'}`}>
            {message.text}
          </span>
        )}
      </div>

      <p className="text-[11px] text-gray-400">
        保存時にAmazonへ実際に認証を行い、通らない場合は保存しません。
        「接続する」でエラーが出る場合は、クライアントID・シークレット・リフレッシュトークンの組み合わせをご確認ください。
      </p>
    </div>
  )
}
