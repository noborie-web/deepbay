'use client'

import { useState, useRef, useCallback } from 'react'
import type { InventoryActiveListing } from '@/types/database'

interface InventoryRun {
  id: string
  run_type: string
  status: string
  items_total: number | null
  items_matched: number | null
  error_message: string | null
  started_at: string
  finished_at: string | null
}

interface Settings {
  has_token: boolean
  sync_enabled: boolean
  ebay_auto_sync: boolean
  days_until_delist: number
  daily_run_count: number
  ebay_token_expires_at: string | null
}

interface Props {
  listings: InventoryActiveListing[]
  hasToken: boolean
}

type Tab = '暗号化復元' | '稼働状況' | '設定' | '積み上げ設定' | '重複チェック'

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? 'bg-green-500' : 'bg-gray-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

export default function InventoryPanel({ listings: initialListings, hasToken: initialHasToken }: Props) {
  const [tab, setTab] = useState<Tab>('暗号化復元')
  const [listings, setListings] = useState<InventoryActiveListing[]>(initialListings)

  // 暗号化復元
  const [dbkId, setDbkId] = useState('')
  const [lookupResult, setLookupResult] = useState<{ found: boolean; source_url: string | null; title?: string } | null>(null)
  const [looking, setLooking] = useState(false)

  // 稼働状況
  const [runs, setRuns] = useState<InventoryRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // 設定
  const [settings, setSettings] = useState<Settings>({
    has_token: initialHasToken,
    sync_enabled: false,
    ebay_auto_sync: false,
    days_until_delist: 29,
    daily_run_count: 1,
    ebay_token_expires_at: null,
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 6000)
  }

  const loadRuns = useCallback(async () => {
    if (runsLoaded) return
    const res = await fetch('/api/inventory/runs')
    if (res.ok) {
      const data = await res.json()
      setRuns(data.runs ?? [])
    }
    setRunsLoaded(true)
  }, [runsLoaded])

  const loadSettings = useCallback(async () => {
    if (settingsLoaded) return
    const res = await fetch('/api/inventory/settings')
    if (res.ok) {
      const data = await res.json()
      if (data.settings) setSettings(data.settings)
    }
    setSettingsLoaded(true)
  }, [settingsLoaded])

  const handleTabChange = (t: Tab) => {
    setTab(t)
    if (t === '稼働状況') loadRuns()
    if (t === '設定') loadSettings()
  }

  // 暗号化復元
  const handleLookup = async () => {
    if (!dbkId.trim()) return
    setLooking(true)
    setLookupResult(null)
    try {
      const res = await fetch(`/api/inventory/lookup?code=${encodeURIComponent(dbkId.trim())}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'エラーが発生しました')
      setLookupResult(json)
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : 'エラーが発生しました')
    } finally {
      setLooking(false)
    }
  }

  // eBay同期
  const handleSync = async () => {
    setSyncing(true)
    setMessage(null)
    try {
      const res = await fetch('/api/inventory/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Sync failed')
      showMsg('success', `同期完了: ${json.total}件取得、${json.matched}件マッチ`)
      const listRes = await fetch('/api/inventory/listings')
      if (listRes.ok) {
        const data = await listRes.json()
        setListings(data.listings ?? [])
      }
      setRunsLoaded(false)
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '同期に失敗しました')
    } finally {
      setSyncing(false)
    }
  }

  // CSVアップロード
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setMessage(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/inventory/upload', { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Upload failed')
      showMsg('success', `アップロード完了: ${json.total}件取得、${json.matched}件マッチ`)
      const listRes = await fetch('/api/inventory/listings')
      if (listRes.ok) {
        const data = await listRes.json()
        setListings(data.listings ?? [])
      }
      setRunsLoaded(false)
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : 'アップロードに失敗しました')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // 設定保存
  const saveSetting = async (patch: Partial<Settings>) => {
    setSavingSettings(true)
    try {
      const res = await fetch('/api/inventory/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '保存に失敗しました')
      setSettings(prev => ({ ...prev, ...patch }))
    } catch (e) {
      showMsg('error', e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSavingSettings(false)
    }
  }

  // 結果CSVダウンロード（現在のリスティング一覧）
  const handleDownloadRun = (run: InventoryRun) => {
    const headers = ['実行日時', 'タイプ', 'ステータス', 'active件数', 'マッチ件数', 'エラー']
    const row = [
      new Date(run.started_at).toLocaleString('ja-JP'),
      run.run_type,
      run.status,
      run.items_total ?? '',
      run.items_matched ?? '',
      run.error_message ?? '',
    ]
    const csv = [headers, row].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `inventory_run_${run.started_at.slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const tabs: Tab[] = ['暗号化復元', '稼働状況', '設定', '積み上げ設定', '重複チェック']

  return (
    <div className="bg-white border rounded-md mb-6">
      {/* タブ */}
      <div className="flex border-b px-4 pt-3 gap-6">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* メッセージ */}
      {message && (
        <div className={`mx-4 mt-3 px-4 py-2 rounded text-sm ${
          message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}

      {/* ==================== 暗号化復元 ==================== */}
      {tab === '暗号化復元' && (
        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">
            DeepBayで抽出時に発行される管理番号 DBK-ID をもとに、元の仕入れ先URLへ復元します。
          </p>
          <div className="flex gap-2 max-w-lg">
            <input
              type="text"
              value={dbkId}
              onChange={e => setDbkId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLookup()}
              placeholder="DBK-IDを入力してください（例: ele_20260730_...）"
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleLookup}
              disabled={looking || !dbkId.trim()}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {looking ? '復元中...' : '復元'}
            </button>
          </div>

          <div className="mt-4 max-w-lg border rounded p-4 min-h-[80px] bg-gray-50 text-sm">
            {lookupResult === null ? (
              <p className="text-gray-400">復元結果がありません。</p>
            ) : lookupResult.found ? (
              <div>
                {lookupResult.title && <p className="font-medium text-gray-800 mb-1">{lookupResult.title}</p>}
                {lookupResult.source_url ? (
                  <a href={lookupResult.source_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">
                    {lookupResult.source_url}
                  </a>
                ) : (
                  <p className="text-gray-500">URLが登録されていません。</p>
                )}
              </div>
            ) : (
              <p className="text-gray-500">該当する商品が見つかりませんでした。</p>
            )}
          </div>
        </div>
      )}

      {/* ==================== 稼働状況 ==================== */}
      {tab === '稼働状況' && (
        <div className="p-6">
          {/* 時間説明 */}
          <div className="bg-gray-50 border rounded p-4 mb-5 text-xs text-gray-600 space-y-1">
            <p className="font-medium text-gray-700 mb-2">在庫管理稼働に関する各時間の説明</p>
            <p><span className="font-medium">7時:</span> 自動同期が有効になっている場合、7時に最新のactiveファイルを取得します。</p>
            <p><span className="font-medium">9時:</span> 自分でアクティブファイルをアップロードされる方は9時までにアップロードすると当日の在庫管理が可能です。</p>
            <p><span className="font-medium">11時:</span> 在庫管理の本番稼働前の状況確認。</p>
            <p><span className="font-medium">13時:</span> 在庫管理の本番稼働開始。9時時点でツールに存在する最新のactiveファイルを参照して在庫管理開始。</p>
          </div>

          {/* 実行履歴テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">チェック日時</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">タイプ</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">active件数</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">マッチ件数</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">稼働状況</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">結果ファイル</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-400 text-sm">
                      実行履歴がありません
                    </td>
                  </tr>
                ) : (
                  runs.map(run => (
                    <tr key={run.id} className="border-b hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {new Date(run.started_at).toLocaleString('ja-JP')}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {run.run_type === 'sync' ? 'eBay同期' : 'CSVアップロード'}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 text-right">{run.items_total ?? '—'}</td>
                      <td className="px-3 py-2 text-xs text-gray-600 text-right">{run.items_matched ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                          run.status === 'completed' ? 'bg-green-100 text-green-700' :
                          run.status === 'failed' ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          {run.status === 'completed' ? '完了' : run.status === 'failed' ? '失敗' : '実行中'}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {run.status === 'completed' && (
                          <button
                            onClick={() => handleDownloadRun(run)}
                            className="px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                          >
                            DL
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== 設定 ==================== */}
      {tab === '設定' && (
        <div className="p-6 space-y-6 max-w-2xl">
          <p className="text-xs text-amber-600 font-medium border border-amber-200 bg-amber-50 rounded px-3 py-2">
            現在は監視モードです。eBay商品の自動取り下げ・価格変更は実行しません。
          </p>

          {/* 在庫管理稼働設定 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-3">在庫管理稼働設定</h3>
            <div className="flex items-center gap-3">
              <Toggle
                checked={settings.sync_enabled}
                onChange={v => saveSetting({ sync_enabled: v })}
                disabled={savingSettings}
              />
              <span className="text-sm text-gray-700">在庫管理を行う</span>
            </div>
          </div>

          <hr />

          {/* eBay商品自動同期設定 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">eBay商品自動同期設定</h3>
            <div className="flex items-center gap-3 mt-3">
              <Toggle
                checked={settings.ebay_auto_sync}
                onChange={v => saveSetting({ ebay_auto_sync: v })}
                disabled={savingSettings || !settings.has_token}
              />
              <span className="text-sm text-gray-700">自動同期を行う</span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              ONにした場合は9時にeBayのactive商品の情報を自動取得しツールに同期します。<br />
              自分でactiveファイルをアップロードする場合は、この設定を「OFF」にしてください。
            </p>
            {!settings.has_token && (
              <p className="text-xs text-red-500 mt-1">eBayトークンが設定されていないため自動同期は無効です。</p>
            )}
          </div>

          <hr />

          {/* eBay Activeファイルアップロード */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">eBay Activeファイルアップロード</h3>
            <p className="text-xs text-gray-500 mb-3">
              eBay Seller Hub &gt; Reports &gt; Downloads からダウンロードしたactiveファイルをアップロードします。
            </p>
            <div className="flex items-center gap-2">
              <label className={`flex items-center gap-2 border rounded px-3 py-2 text-sm cursor-pointer ${
                uploading ? 'opacity-50 pointer-events-none bg-gray-50' : 'bg-white hover:bg-gray-50'
              }`}>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  ref={fileRef}
                  onChange={handleUpload}
                  disabled={uploading}
                />
                <span className="text-gray-400">📎</span>
                <span className="text-gray-600">
                  {uploading ? 'アップロード中...' : 'eBayからダウンロードしたactiveファイルを選択'}
                </span>
              </label>
            </div>
            <div className="mt-3">
              <button
                onClick={handleSync}
                disabled={syncing || !settings.has_token}
                title={!settings.has_token ? 'eBayトークンを設定してください' : undefined}
                className={`px-4 py-2 text-sm rounded ${
                  syncing || !settings.has_token
                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {syncing ? 'eBay同期中...' : 'eBay同期を今すぐ実行'}
              </button>
            </div>
          </div>

          <hr />

          {/* N日経過取り下げ */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">N日経過取り下げ</h3>
            <p className="text-xs text-gray-500 mb-3">出品から指定した日数が経過した商品を取り下げます。（監視モードでは実行されません）</p>
            <div className="flex items-center gap-3">
              <Toggle
                checked={settings.sync_enabled}
                onChange={() => {}}
                disabled={true}
              />
              <span className="text-sm text-gray-400">有効（監視モード中は無効）</span>
              <div className="ml-4 flex items-center gap-2">
                <span className="text-xs text-gray-500">取り下げ対象の経過日数</span>
                <input
                  type="number"
                  value={settings.days_until_delist}
                  min={1}
                  max={365}
                  onChange={e => setSettings(prev => ({ ...prev, days_until_delist: Number(e.target.value) }))}
                  onBlur={() => saveSetting({ days_until_delist: settings.days_until_delist })}
                  className="w-20 border rounded px-2 py-1 text-sm text-center"
                />
              </div>
            </div>
          </div>

          <hr />

          {/* 在庫管理実行回数 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">1日の全体在庫管理の稼働回数</h3>
            <p className="text-xs text-gray-500 mb-3">最大3回まで設定可能。2回: 約11時間ごと、3回: 約7時間ごとに実行。</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={settings.daily_run_count}
                min={1}
                max={3}
                onChange={e => setSettings(prev => ({ ...prev, daily_run_count: Number(e.target.value) }))}
                onBlur={() => saveSetting({ daily_run_count: settings.daily_run_count })}
                className="w-20 border rounded px-2 py-1 text-sm text-center"
              />
              <span className="text-xs text-gray-500">回（最大3回）</span>
            </div>
          </div>
        </div>
      )}

      {/* ==================== 積み上げ設定 ==================== */}
      {tab === '積み上げ設定' && (
        <div className="p-6">
          <div className="text-center py-12 text-gray-400">
            <p className="text-sm">積み上げ設定はオプション機能です。</p>
            <p className="text-xs mt-1">商品が販売された際に、自動で積み上げ対象に登録する機能です。</p>
          </div>
        </div>
      )}

      {/* ==================== 重複チェック ==================== */}
      {tab === '重複チェック' && (
        <div className="p-6">
          <div className="text-center py-12 text-gray-400">
            <p className="text-sm">重複チェックはオプション機能です。</p>
            <p className="text-xs mt-1">在庫管理の仕入れ元情報の差分検知をすることが可能です。</p>
          </div>
        </div>
      )}

      {/* ==================== アクティブリスト（設定タブ以外に表示） ==================== */}
      {tab !== '設定' && tab !== '積み上げ設定' && tab !== '重複チェック' && tab !== '暗号化復元' && tab !== '稼働状況' && (
        <div className="border-t p-4">
          <p className="text-sm text-gray-500">出品データ: {listings.length}件</p>
        </div>
      )}
    </div>
  )
}
