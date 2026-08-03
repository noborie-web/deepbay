'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { InventoryActiveListing } from '@/types/database'

interface InventoryRun {
  id: string; run_type: string; status: string
  items_total: number | null; items_matched: number | null
  error_message: string | null; started_at: string; finished_at: string | null
}

interface Settings {
  has_token: boolean; sync_enabled: boolean; ebay_auto_sync: boolean
  days_until_delist: number; daily_run_count: number; ebay_token_expires_at: string | null
}

interface StackingItem {
  id: string; ebay_item_id: string; title: string
  custom_label: string | null; current_price: number | null; quantity: number | null
  product_id: string | null; source_url: string | null; image_url: string | null
  new_source_url: string | null; in_stacking: boolean; fetched_at: string
}

interface DupCheckConfig {
  id: string; check_columns: string[]; auto_check: boolean
  priority: number; last_checked_at: string | null; last_found_count: number | null
  created_at: string
}

interface Props {
  listings: InventoryActiveListing[]
  hasToken: boolean
}

type Tab = '暗号化復元' | '稼働状況' | '設定' | '積み上げ設定' | '重複チェック'

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-green-500' : 'bg-gray-300'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function downloadCsvBlob(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export default function InventoryPanel({ listings: initialListings, hasToken: initialHasToken }: Props) {
  const [tab, setTab] = useState<Tab>('暗号化復元')
  const [listings] = useState<InventoryActiveListing[]>(initialListings)

  // 暗号化復元
  const [dbkId, setDbkId] = useState('')
  const [lookupResult, setLookupResult] = useState<{ found: boolean; source_url: string | null; title?: string } | null>(null)
  const [looking, setLooking] = useState(false)

  // 稼働状況
  const [runs, setRuns] = useState<InventoryRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [dlModal, setDlModal] = useState<{ runId: string } | null>(null)
  const [dlFileType, setDlFileType] = useState<'end_items' | 'diff' | 'revise' | 'duplicate'>('end_items')
  const [dlDiffCols, setDlDiffCols] = useState<string[]>(['title', 'price'])
  const [downloading, setDownloading] = useState(false)

  // 設定
  const [settings, setSettings] = useState<Settings>({
    has_token: initialHasToken, sync_enabled: false, ebay_auto_sync: false,
    days_until_delist: 29, daily_run_count: 1, ebay_token_expires_at: null,
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 積み上げ設定
  const [stackingItems, setStackingItems] = useState<StackingItem[]>([])
  const [stackingLoaded, setStackingLoaded] = useState(false)
  const [stackingSearch, setStackingSearch] = useState('')
  const [addingUrl, setAddingUrl] = useState<{ ebay_item_id: string; url: string } | null>(null)
  const [stackingSaving, setStackingSaving] = useState(false)

  // 重複チェック
  const [dupConfigs, setDupConfigs] = useState<DupCheckConfig[]>([])
  const [dupLoaded, setDupLoaded] = useState(false)
  const [creatingDup, setCreatingDup] = useState(false)
  const [newDupCols, setNewDupCols] = useState<string[]>(['url', 'title'])
  const [runningDup, setRunningDup] = useState<string | null>(null)

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    setTimeout(() => setMessage(null), 6000)
  }

  const loadRuns = useCallback(async () => {
    if (runsLoaded) return
    const res = await fetch('/api/inventory/runs')
    if (res.ok) { const d = await res.json(); setRuns(d.runs ?? []) }
    setRunsLoaded(true)
  }, [runsLoaded])

  const loadSettings = useCallback(async () => {
    if (settingsLoaded) return
    const res = await fetch('/api/inventory/settings')
    if (res.ok) { const d = await res.json(); if (d.settings) setSettings(d.settings) }
    setSettingsLoaded(true)
  }, [settingsLoaded])

  const loadStacking = useCallback(async () => {
    if (stackingLoaded) return
    const res = await fetch('/api/inventory/stacking')
    if (res.ok) { const d = await res.json(); setStackingItems(d.items ?? []) }
    setStackingLoaded(true)
  }, [stackingLoaded])

  const loadDupConfigs = useCallback(async () => {
    if (dupLoaded) return
    const res = await fetch('/api/inventory/duplicate-checks')
    if (res.ok) { const d = await res.json(); setDupConfigs(d.configs ?? []) }
    setDupLoaded(true)
  }, [dupLoaded])

  const handleTabChange = (t: Tab) => {
    setTab(t)
    if (t === '稼働状況') loadRuns()
    if (t === '設定') loadSettings()
    if (t === '積み上げ設定') loadStacking()
    if (t === '重複チェック') loadDupConfigs()
  }

  // クリックで初回ロードが走るようにする
  useEffect(() => { /* initial tab: no preload */ }, [])

  // 暗号化復元
  const handleLookup = async () => {
    if (!dbkId.trim()) return
    setLooking(true); setLookupResult(null)
    try {
      const res = await fetch(`/api/inventory/lookup?code=${encodeURIComponent(dbkId.trim())}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'エラーが発生しました')
      setLookupResult(json)
    } catch (e) { showMsg('error', e instanceof Error ? e.message : 'エラー') }
    finally { setLooking(false) }
  }

  // eBay同期
  const handleSync = async () => {
    setSyncing(true); setMessage(null)
    try {
      const res = await fetch('/api/inventory/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Sync failed')
      showMsg('success', `同期完了: ${json.total}件取得、${json.matched}件マッチ`)
      setRunsLoaded(false)
    } catch (e) { showMsg('error', e instanceof Error ? e.message : '同期失敗') }
    finally { setSyncing(false) }
  }

  // CSVアップロード
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    setUploading(true); setMessage(null)
    try {
      const formData = new FormData(); formData.append('file', file)
      const res = await fetch('/api/inventory/upload', { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Upload failed')
      showMsg('success', `アップロード完了: ${json.total}件取得、${json.matched}件マッチ`)
      setRunsLoaded(false)
    } catch (e) { showMsg('error', e instanceof Error ? e.message : 'アップロード失敗') }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  // 設定保存
  const saveSetting = async (patch: Partial<Settings>) => {
    setSavingSettings(true)
    try {
      const res = await fetch('/api/inventory/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      setSettings(prev => ({ ...prev, ...patch }))
    } catch (e) { showMsg('error', e instanceof Error ? e.message : '保存失敗') }
    finally { setSavingSettings(false) }
  }

  // 稼働状況DLモーダル
  const handleDownload = async () => {
    setDownloading(true)
    try {
      const res = await fetch('/api/inventory/runs/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_type: dlFileType, diff_columns: dlDiffCols }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'ダウンロード失敗')
      downloadCsvBlob(json.csv, json.filename)
      setDlModal(null)
    } catch (e) { showMsg('error', e instanceof Error ? e.message : 'ダウンロード失敗') }
    finally { setDownloading(false) }
  }

  // 積み上げ: 在庫追加
  const handleStackingAdd = async (ebay_item_id: string, new_source_url: string) => {
    setStackingSaving(true)
    try {
      const res = await fetch('/api/inventory/stacking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ebay_item_id, new_source_url }),
      })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      setStackingItems(prev => prev.map(i => i.ebay_item_id === ebay_item_id
        ? { ...i, new_source_url, in_stacking: true } : i))
      setAddingUrl(null)
    } catch (e) { showMsg('error', e instanceof Error ? e.message : '追加失敗') }
    finally { setStackingSaving(false) }
  }

  // 積み上げ: 削除（除外）
  const handleStackingDelete = async (ebay_item_id: string) => {
    try {
      const res = await fetch('/api/inventory/stacking', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ebay_item_id }),
      })
      if (!res.ok) throw new Error()
      setStackingItems(prev => prev.filter(i => i.ebay_item_id !== ebay_item_id))
    } catch { showMsg('error', '削除に失敗しました') }
  }

  // 重複チェック: 新規作成
  const handleCreateDupConfig = async () => {
    setCreatingDup(true)
    try {
      const res = await fetch('/api/inventory/duplicate-checks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ check_columns: newDupCols, auto_check: false, priority: dupConfigs.length + 1 }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setDupLoaded(false); loadDupConfigs()
      setNewDupCols(['url', 'title'])
    } catch (e) { showMsg('error', e instanceof Error ? e.message : '作成失敗') }
    finally { setCreatingDup(false) }
  }

  // 重複チェック: 実行
  const handleRunDupCheck = async (configId: string) => {
    setRunningDup(configId)
    try {
      const res = await fetch(`/api/inventory/duplicate-checks/${configId}/run`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      showMsg('success', `重複チェック完了: ${json.found}件の重複を検出`)
      setDupLoaded(false); loadDupConfigs()
      // 重複CSVをダウンロード
      const dlRes = await fetch('/api/inventory/runs/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_type: 'duplicate' }),
      })
      if (dlRes.ok) { const d = await dlRes.json(); downloadCsvBlob(d.csv, d.filename) }
    } catch (e) { showMsg('error', e instanceof Error ? e.message : 'チェック失敗') }
    finally { setRunningDup(null) }
  }

  // 重複チェック: 削除
  const handleDeleteDupConfig = async (configId: string) => {
    try {
      const res = await fetch(`/api/inventory/duplicate-checks/${configId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      setDupConfigs(prev => prev.filter(c => c.id !== configId))
    } catch { showMsg('error', '削除に失敗しました') }
  }

  // 重複チェック: 自動チェックトグル
  const handleToggleAutoCheck = async (configId: string, auto_check: boolean) => {
    try {
      const res = await fetch(`/api/inventory/duplicate-checks/${configId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_check }),
      })
      if (!res.ok) throw new Error()
      setDupConfigs(prev => prev.map(c => c.id === configId ? { ...c, auto_check } : c))
    } catch { showMsg('error', '更新に失敗しました') }
  }

  const filteredStackingItems = stackingItems.filter(i =>
    !stackingSearch || i.title?.includes(stackingSearch) || i.ebay_item_id.includes(stackingSearch)
  )

  const tabs: Tab[] = ['暗号化復元', '稼働状況', '設定', '積み上げ設定', '重複チェック']

  return (
    <div className="bg-white border rounded-md mb-6">
      {/* タブ */}
      <div className="flex border-b px-4 pt-3 gap-6">
        {tabs.map(t => (
          <button key={t} onClick={() => handleTabChange(t)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {message && (
        <div className={`mx-4 mt-3 px-4 py-2 rounded text-sm ${message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {message.text}
        </div>
      )}

      {/* ==================== 暗号化復元 ==================== */}
      {tab === '暗号化復元' && (
        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">DeepBayで抽出時に発行される管理番号 DBK-ID をもとに、元の仕入れ先URLへ復元します。</p>
          <div className="flex gap-2 max-w-lg">
            <input type="text" value={dbkId} onChange={e => setDbkId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLookup()}
              placeholder="DBK-IDを入力してください（例: ele_20260730_...）"
              className="flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
            <button onClick={handleLookup} disabled={looking || !dbkId.trim()}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50">
              {looking ? '復元中...' : '復元'}
            </button>
          </div>
          <div className="mt-4 max-w-lg border rounded p-4 min-h-[80px] bg-gray-50 text-sm">
            {lookupResult === null ? <p className="text-gray-400">復元結果がありません。</p>
              : lookupResult.found ? (
                <div>
                  {lookupResult.title && <p className="font-medium text-gray-800 mb-1">{lookupResult.title}</p>}
                  {lookupResult.source_url
                    ? <a href={lookupResult.source_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline break-all">{lookupResult.source_url}</a>
                    : <p className="text-gray-500">URLが登録されていません。</p>}
                </div>
              ) : <p className="text-gray-500">該当する商品が見つかりませんでした。</p>}
          </div>
        </div>
      )}

      {/* ==================== 稼働状況 ==================== */}
      {tab === '稼働状況' && (
        <div className="p-6">
          <div className="bg-gray-50 border rounded p-4 mb-5 text-xs text-gray-600 space-y-1">
            <p className="font-medium text-gray-700 mb-2">在庫管理稼働に関する各時間の説明</p>
            <p><strong>7時:</strong> 自動同期が有効になっている場合、7時に最新のactiveファイルを取得します。<span className="text-gray-400 ml-1">※この時間が過ぎると翌日のタイミングで在庫管理をすることになります。</span></p>
            <p><strong>9時:</strong> 自分でアクティブファイルをアップロードされる方は9時までにアップロードすると当日の在庫管理が可能です。<span className="text-gray-400 ml-1">※この時間が過ぎると翌日のタイミングとなります。</span></p>
            <p><strong>11時:</strong> 在庫管理の本番稼働前の状況確認。</p>
            <p><strong>13時:</strong> 在庫管理の本番稼働開始。9時段階でツールに存在する最新のactiveファイルを参照して在庫管理開始。</p>
          </div>

          <div className="overflow-x-auto mb-6">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b">
                  {['チェック日時', 'タイプ', 'active件数', 'マッチ件数', '稼働状況', '稼働結果ファイル'].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400 text-sm">実行履歴がありません</td></tr>
                ) : runs.map(run => (
                  <tr key={run.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2 text-xs text-gray-600">{new Date(run.started_at).toLocaleString('ja-JP')}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{run.run_type === 'sync' ? 'eBay同期' : 'CSVアップロード'}</td>
                    <td className="px-3 py-2 text-xs text-gray-600 text-right">{run.items_total ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-600 text-right">{run.items_matched ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${run.status === 'completed' ? 'bg-green-100 text-green-700' : run.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                        {run.status === 'completed' ? '稼働' : run.status === 'failed' ? '失敗' : '実行中'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {run.status === 'completed' && (
                        <button onClick={() => setDlModal({ runId: run.id })}
                          className="px-2 py-1 border border-green-600 text-green-600 text-xs rounded hover:bg-green-50">
                          DL
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 在庫管理状況 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-3">在庫管理状況</h3>
            <table className="w-full text-sm border border-gray-200 rounded">
              <thead>
                <tr className="bg-gray-50 border-b">
                  {['1日の在庫管理可能回数', '月間在庫管理可能回数', '在庫管理件数', '在庫管理件数残高'].map(h => (
                    <th key={h} className="text-left px-4 py-2 text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="px-4 py-2 text-sm text-gray-700">{settings.daily_run_count * 10000}</td>
                  <td className="px-4 py-2 text-sm text-gray-700">{settings.daily_run_count * 310000}</td>
                  <td className="px-4 py-2 text-sm text-gray-700">{listings.length}</td>
                  <td className="px-4 py-2 text-sm text-gray-700">{Math.max(0, settings.daily_run_count * 310000 - listings.length)}</td>
                </tr>
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
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-3">在庫管理稼働設定</h3>
            <div className="flex items-center gap-3">
              <Toggle checked={settings.sync_enabled} onChange={v => saveSetting({ sync_enabled: v })} disabled={savingSettings} />
              <span className="text-sm text-gray-700">在庫管理を行う</span>
            </div>
          </div>
          <hr />
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">eBay商品自動同期設定</h3>
            <div className="flex items-center gap-3 mt-3">
              <Toggle checked={settings.ebay_auto_sync} onChange={v => saveSetting({ ebay_auto_sync: v })} disabled={savingSettings || !settings.has_token} />
              <span className="text-sm text-gray-700">自動同期を行う</span>
            </div>
            <p className="text-xs text-gray-500 mt-2">ONにした場合は9時にeBayのactive商品の情報を自動取得しツールに同期します。</p>
            {!settings.has_token && <p className="text-xs text-red-500 mt-1">eBayトークンが設定されていないため自動同期は無効です。</p>}
          </div>
          <hr />
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">eBay Activeファイルアップロード</h3>
            <p className="text-xs text-gray-500 mb-3">eBay Seller Hub &gt; Reports &gt; Downloads からダウンロードしたactiveファイルをアップロードします。</p>
            <div className="flex items-center gap-3">
              <label className={`flex items-center gap-2 border rounded px-3 py-2 text-sm cursor-pointer ${uploading ? 'opacity-50 pointer-events-none bg-gray-50' : 'bg-white hover:bg-gray-50'}`}>
                <input type="file" accept=".csv,text/csv" className="hidden" ref={fileRef} onChange={handleUpload} disabled={uploading} />
                <span className="text-gray-400">📎</span>
                <span className="text-gray-600">{uploading ? 'アップロード中...' : 'eBayからダウンロードしたactiveファイルを選択'}</span>
              </label>
              <button onClick={handleSync} disabled={syncing || !settings.has_token}
                className={`px-4 py-2 text-sm rounded ${syncing || !settings.has_token ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                {syncing ? 'eBay同期中...' : 'eBay同期を今すぐ実行'}
              </button>
            </div>
          </div>
          <hr />
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">N日経過取り下げ</h3>
            <p className="text-xs text-gray-500 mb-3">出品から指定した日数が経過した商品を取り下げます。（監視モードでは実行されません）</p>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">取り下げ対象の経過日数</span>
              <input type="number" value={settings.days_until_delist} min={1} max={365}
                onChange={e => setSettings(prev => ({ ...prev, days_until_delist: Number(e.target.value) }))}
                onBlur={() => saveSetting({ days_until_delist: settings.days_until_delist })}
                className="w-20 border rounded px-2 py-1 text-sm text-center" />
            </div>
          </div>
          <hr />
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">1日の全体在庫管理の稼働回数</h3>
            <p className="text-xs text-gray-500 mb-3">最大3回まで設定可能。2回: 約11時間ごと、3回: 約7時間ごとに実行。</p>
            <div className="flex items-center gap-2">
              <input type="number" value={settings.daily_run_count} min={1} max={3}
                onChange={e => setSettings(prev => ({ ...prev, daily_run_count: Number(e.target.value) }))}
                onBlur={() => saveSetting({ daily_run_count: settings.daily_run_count })}
                className="w-20 border rounded px-2 py-1 text-sm text-center" />
              <span className="text-xs text-gray-500">回（最大3回）</span>
            </div>
          </div>
        </div>
      )}

      {/* ==================== 積み上げ設定 ==================== */}
      {tab === '積み上げ設定' && (
        <div className="p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">SOLD積み上げ商品状況</h2>
          <p className="text-xs text-red-500 mb-4">※ 当ツールにアップロードされている最新のアクティブファイルを元に表示している為、eBay側の状態と異なる場合があります</p>

          <div className="flex gap-3 mb-4">
            <button onClick={() => { setStackingLoaded(false); loadStacking() }}
              className="px-3 py-1.5 border border-green-600 text-green-700 text-xs rounded hover:bg-green-50">
              再読み込み
            </button>
            <input type="text" value={stackingSearch} onChange={e => setStackingSearch(e.target.value)}
              placeholder="検索" className="flex-1 border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">商品画像</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">アイテムID</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">商品タイトル</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">eBay在庫数</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">eBay販売価格</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">管理番号</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">URL</th>
                  <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">操作</th>
                </tr>
              </thead>
              <tbody>
                {!stackingLoaded ? (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-sm">読み込み中...</td></tr>
                ) : filteredStackingItems.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400 text-sm">SOLD商品がありません</td></tr>
                ) : filteredStackingItems.map(item => (
                  <tr key={item.ebay_item_id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden">
                        {item.image_url && <img src={item.image_url} alt="" className="w-full h-full object-cover" />}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <a href={`https://www.ebay.com/itm/${item.ebay_item_id}`} target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 underline text-xs">{item.ebay_item_id}</a>
                    </td>
                    <td className="px-3 py-2 max-w-[200px]">
                      <p className="text-xs text-gray-800 truncate">{item.title}</p>
                    </td>
                    <td className="px-3 py-2 text-xs text-center text-gray-600">{item.quantity ?? 0}</td>
                    <td className="px-3 py-2 text-xs text-right text-gray-700">
                      {item.current_price != null ? `$${item.current_price.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 max-w-[160px]">
                      <span className="truncate block">{item.custom_label ?? '—'}</span>
                    </td>
                    <td className="px-3 py-2 text-xs max-w-[180px]">
                      {item.new_source_url ? (
                        <a href={item.new_source_url} target="_blank" rel="noopener noreferrer"
                          className="text-blue-600 underline truncate block">{item.new_source_url}</a>
                      ) : item.source_url ? (
                        <a href={item.source_url} target="_blank" rel="noopener noreferrer"
                          className="text-gray-500 underline truncate block">{item.source_url}</a>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        {addingUrl?.ebay_item_id === item.ebay_item_id ? (
                          <div className="flex gap-1">
                            <input type="url" value={addingUrl.url} onChange={e => setAddingUrl({ ...addingUrl, url: e.target.value })}
                              placeholder="新URLを入力" className="border rounded px-2 py-0.5 text-xs w-40 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                            <button onClick={() => handleStackingAdd(item.ebay_item_id, addingUrl.url)} disabled={stackingSaving || !addingUrl.url}
                              className="px-2 py-0.5 bg-blue-600 text-white text-xs rounded disabled:opacity-50">保存</button>
                            <button onClick={() => setAddingUrl(null)} className="px-2 py-0.5 border text-xs rounded">✕</button>
                          </div>
                        ) : (
                          <button onClick={() => setAddingUrl({ ebay_item_id: item.ebay_item_id, url: item.new_source_url ?? '' })}
                            className="px-2 py-0.5 border border-blue-400 text-blue-600 text-xs rounded hover:bg-blue-50">
                            在庫追加
                          </button>
                        )}
                        <button onClick={() => handleStackingDelete(item.ebay_item_id)}
                          className="px-2 py-0.5 border border-red-400 text-red-600 text-xs rounded hover:bg-red-50">
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== 重複チェック ==================== */}
      {tab === '重複チェック' && (
        <div className="p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-1">重複チェック設定</h2>
          <p className="text-xs text-gray-500 mb-1">設定に基づき、重複してeBayに出品されている商品を検出します。</p>
          <p className="text-xs text-gray-500 mb-1">現在ツールに反映されている最新のactiveファイルを元に重複チェックを行います。</p>
          <p className="text-xs text-gray-500 mb-4">「重複チェック実行」ボタンからチェックを行った場合はCSVファイルがダウンロードされますので、それを各eBayアカウントにアップロードしていただく必要がございます。</p>

          {/* 新規作成フォーム */}
          <div className="mb-5 p-4 border rounded bg-gray-50">
            <p className="text-xs font-medium text-gray-700 mb-2">新規チェック設定</p>
            <div className="flex items-center gap-4 mb-3">
              <span className="text-xs text-gray-600">チェック対象列:</span>
              {['url', 'title'].map(col => (
                <label key={col} className="flex items-center gap-1 text-xs text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={newDupCols.includes(col)}
                    onChange={e => setNewDupCols(prev => e.target.checked ? [...prev, col] : prev.filter(c => c !== col))}
                    className="rounded" />
                  {col === 'url' ? 'URL' : 'タイトル'}
                </label>
              ))}
            </div>
            <button onClick={handleCreateDupConfig} disabled={creatingDup || newDupCols.length === 0}
              className="px-4 py-1.5 border border-blue-500 text-blue-600 text-xs rounded hover:bg-blue-50 disabled:opacity-50">
              {creatingDup ? '作成中...' : '新規作成'}
            </button>
          </div>

          {/* 設定一覧 */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  {['自動重複チェック', '最終チェック日時', '最終チェック取り下げ数', 'チェック対象列', '操作'].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-xs font-medium text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!dupLoaded ? (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-400 text-sm">読み込み中...</td></tr>
                ) : dupConfigs.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-400 text-sm">設定がありません。新規作成してください。</td></tr>
                ) : dupConfigs.map(config => (
                  <tr key={config.id} className="border-b hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Toggle checked={config.auto_check} onChange={v => handleToggleAutoCheck(config.id, v)} />
                        <span className="text-xs text-gray-600">{config.auto_check ? '有効' : '無効'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {config.last_checked_at ? new Date(config.last_checked_at).toLocaleString('ja-JP') : '未実行'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {config.last_found_count != null ? `${config.last_found_count}件` : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {config.check_columns.join(', ')}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <button onClick={() => handleRunDupCheck(config.id)} disabled={runningDup === config.id}
                          className="px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50">
                          {runningDup === config.id ? '実行中...' : '重複チェック実行'}
                        </button>
                        <button onClick={() => navigator.clipboard.writeText(config.id)}
                          className="px-2 py-1 border text-xs rounded hover:bg-gray-50">
                          設定IDコピー
                        </button>
                        <button onClick={() => handleDeleteDupConfig(config.id)}
                          className="px-2 py-1 border border-red-400 text-red-600 text-xs rounded hover:bg-red-50">
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ==================== DLモーダル ==================== */}
      {dlModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6">
            <h3 className="text-sm font-semibold text-gray-800 mb-4">在庫管理結果ファイルダウンロード</h3>
            <p className="text-xs text-gray-500 mb-4">
              「ファイルダウンロード」ボタンをクリックすると、最新の在庫管理結果から取り下げファイル、差分検知ファイルが生成されます。
            </p>

            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-700 mb-1">ファイルタイプ</label>
              <select value={dlFileType} onChange={e => setDlFileType(e.target.value as typeof dlFileType)}
                className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500">
                <option value="end_items">取り下げファイル (end_items)</option>
                <option value="diff">差分検知ファイル (diff)</option>
                <option value="revise">価格改定ファイル (revise)</option>
                <option value="duplicate">重複チェックファイル (duplicate)</option>
              </select>
            </div>

            {dlFileType === 'diff' && (
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-700 mb-2">差分検知項目</label>
                <div className="flex gap-4">
                  {['title', 'price'].map(col => (
                    <label key={col} className="flex items-center gap-1 text-xs text-gray-700 cursor-pointer">
                      <input type="checkbox" checked={dlDiffCols.includes(col)}
                        onChange={e => setDlDiffCols(prev => e.target.checked ? [...prev, col] : prev.filter(c => c !== col))} />
                      {col === 'title' ? 'タイトル' : '価格'}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <button onClick={handleDownload} disabled={downloading}
                className="px-4 py-2 border border-green-600 text-green-700 text-sm rounded hover:bg-green-50 disabled:opacity-50">
                {downloading ? 'ダウンロード中...' : 'ファイルダウンロード'}
              </button>
              <button onClick={() => setDlModal(null)}
                className="px-4 py-2 border border-red-500 text-red-600 text-sm rounded hover:bg-red-50">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
