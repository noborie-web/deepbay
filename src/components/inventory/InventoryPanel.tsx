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
  auto_delist: boolean; auto_revise_price: boolean; auto_stack: boolean
  schedule_time: string
  payment_profile_name: string; return_profile_name: string; shipping_profile_name: string
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

function EbayTokenForm({ hasToken, onSaved }: { hasToken: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(!hasToken)
  const [token, setToken] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function handleSave() {
    if (!token.trim()) { setMsg('トークンを入力してください'); return }
    setSaving(true); setMsg(null)
    const body: Record<string, string> = { ebay_token: token.trim() }
    if (refreshToken.trim()) body.ebay_refresh_token = refreshToken.trim()
    if (expiresAt.trim()) body.ebay_token_expires_at = new Date(expiresAt).toISOString()
    const res = await fetch('/api/inventory/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setSaving(false)
    if (res.ok) {
      setMsg('保存しました')
      setToken(''); setRefreshToken(''); setExpiresAt('')
      setOpen(false)
      onSaved()
    } else { const d = await res.json().catch(() => ({})); setMsg(d.error ?? '保存に失敗しました') }
  }

  if (!open) {
    return (
      <div>
        {msg && <p className="text-xs mb-2 text-green-600">{msg}</p>}
        <button onClick={() => { setOpen(true); setMsg(null) }}
          className="px-3 py-1.5 border border-blue-500 text-blue-600 text-xs rounded hover:bg-blue-50">
          トークンを更新する
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="text-xs text-gray-600">Access Token <span className="text-red-500">*</span></label>
        <textarea value={token} onChange={e => setToken(e.target.value)} rows={3}
          placeholder="v^1.1#i^1#..."
          className="w-full border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 mt-1" />
      </div>
      <div>
        <label className="text-xs text-gray-600">Refresh Token（任意）</label>
        <textarea value={refreshToken} onChange={e => setRefreshToken(e.target.value)} rows={2}
          placeholder="v^1.1#i^1#..."
          className="w-full border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 mt-1" />
      </div>
      <div>
        <label className="text-xs text-gray-600">有効期限（任意・例: 2026-12-31）</label>
        <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)}
          className="border rounded px-2 py-1 text-sm mt-1 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      </div>
      <div className="flex gap-2 items-center">
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {saving ? '保存中...' : 'トークンを保存'}
        </button>
        {hasToken && (
          <button onClick={() => { setOpen(false); setMsg(null) }}
            className="px-3 py-2 text-sm border rounded hover:bg-gray-50 text-gray-600">
            キャンセル
          </button>
        )}
      </div>
      {msg && <p className={`text-xs mt-1 ${msg === '保存しました' ? 'text-green-600' : 'text-red-500'}`}>{msg}</p>}
    </div>
  )
}

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

  // 対象件数サマリー
  interface ActionSummary { delist: number | null; revise_price: number | null; stack: number | null }
  const [actionSummary, setActionSummary] = useState<ActionSummary>({ delist: null, revise_price: null, stack: null })
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [expandedError, setExpandedError] = useState<string | null>(null)

  // 設定
  const [settings, setSettings] = useState<Settings>({
    has_token: initialHasToken, sync_enabled: false, ebay_auto_sync: false,
    days_until_delist: 29, daily_run_count: 1, ebay_token_expires_at: null,
    auto_delist: false, auto_revise_price: false, auto_stack: false,
    schedule_time: '09:00',
    payment_profile_name: '', return_profile_name: '', shipping_profile_name: '',
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

  // アクション確認モーダル
  interface ActionPreviewItem { ebay_item_id: string; title?: string; old_price?: number | null; new_price?: number | null; diff?: number; new_source_url?: string | null }
  const [actionModal, setActionModal] = useState<{ type: 'delist' | 'revise_price' | 'stack'; items: ActionPreviewItem[]; running: boolean } | null>(null)

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

  const refreshRuns = async () => {
    const res = await fetch('/api/inventory/runs')
    if (res.ok) { const d = await res.json(); setRuns(d.runs ?? []) }
  }

  const loadActionSummary = useCallback(async () => {
    setSummaryLoading(true)
    try {
      const [delistRes, reviseRes, stackRes] = await Promise.all([
        fetch('/api/inventory/actions/delist'),
        fetch('/api/inventory/actions/revise-price'),
        fetch('/api/inventory/actions/stack'),
      ])
      const [delistData, reviseData, stackData] = await Promise.all([
        delistRes.ok ? delistRes.json() : { items: [] },
        reviseRes.ok ? reviseRes.json() : { items: [] },
        stackRes.ok ? stackRes.json() : { items: [] },
      ])
      setActionSummary({
        delist: delistData.items?.length ?? 0,
        revise_price: reviseData.items?.length ?? 0,
        stack: stackData.items?.length ?? 0,
      })
    } catch { /* サマリー取得失敗は無視 */ }
    finally { setSummaryLoading(false) }
  }, [])

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
    if (t === '稼働状況') { loadRuns(); loadActionSummary() }
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
        body: JSON.stringify({
          file_type: 'duplicate',
          duplicate_items: json.duplicates ?? [],
        }),
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

  // アクション: 取り下げプレビュー
  const handlePreviewDelist = async () => {
    const res = await fetch('/api/inventory/actions/delist')
    if (!res.ok) { showMsg('error', '取得失敗'); return }
    const d = await res.json()
    setActionModal({ type: 'delist', items: d.items ?? [], running: false })
  }

  // アクション: 価格改定プレビュー
  const handlePreviewRevisePrice = async () => {
    const res = await fetch('/api/inventory/actions/revise-price')
    if (!res.ok) { showMsg('error', '取得失敗'); return }
    const d = await res.json()
    setActionModal({ type: 'revise_price', items: d.items ?? [], running: false })
  }

  // アクション: 積み上げプレビュー
  const handlePreviewStack = async () => {
    const res = await fetch('/api/inventory/actions/stack')
    if (!res.ok) { showMsg('error', '取得失敗'); return }
    const d = await res.json()
    setActionModal({ type: 'stack', items: d.items ?? [], running: false })
  }

  // アクション: 実行
  const handleRunAction = async () => {
    if (!actionModal) return
    setActionModal(prev => prev ? { ...prev, running: true } : null)
    const url = `/api/inventory/actions/${actionModal.type === 'revise_price' ? 'revise-price' : actionModal.type}`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_ids: actionModal.items.map(item => item.ebay_item_id) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '実行失敗')
      const failedCount = Array.isArray(json.failed) ? json.failed.length : 0
      showMsg(failedCount > 0 ? 'error' : 'success',
        failedCount > 0
          ? `一部失敗: ${json.succeeded}件成功 / ${json.total}件（${failedCount}件失敗）`
          : `完了: ${json.succeeded}件成功 / ${json.total}件`)
      setActionModal(null)
      setRunsLoaded(false); loadRuns()
    } catch (e) { showMsg('error', e instanceof Error ? e.message : '実行失敗'); setActionModal(prev => prev ? { ...prev, running: false } : null) }
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
        <div className="p-6 space-y-6">

          {/* 今日の作業サマリー */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">今日の作業内容</h3>
              <button onClick={loadActionSummary} disabled={summaryLoading}
                className="px-2 py-1 border text-xs rounded text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                {summaryLoading ? '確認中...' : '件数を再確認'}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="border rounded-lg p-4 bg-orange-50 border-orange-200">
                <p className="text-xs text-orange-600 font-medium mb-1">取り下げ対象</p>
                <p className="text-2xl font-bold text-orange-700">
                  {summaryLoading ? '…' : actionSummary.delist === null ? '—' : `${actionSummary.delist}件`}
                </p>
                <p className="text-xs text-orange-500 mt-1">{settings.days_until_delist}日経過した商品</p>
                <button onClick={handlePreviewDelist} disabled={summaryLoading || actionSummary.delist === 0}
                  className="mt-3 w-full px-3 py-1.5 bg-orange-600 text-white text-xs rounded hover:bg-orange-700 disabled:opacity-40">
                  取り下げ実行
                </button>
              </div>
              <div className="border rounded-lg p-4 bg-blue-50 border-blue-200">
                <p className="text-xs text-blue-600 font-medium mb-1">価格改定対象</p>
                <p className="text-2xl font-bold text-blue-700">
                  {summaryLoading ? '…' : actionSummary.revise_price === null ? '—' : `${actionSummary.revise_price}件`}
                </p>
                <p className="text-xs text-blue-500 mt-1">仕入れ価格と乖離した商品</p>
                <button onClick={handlePreviewRevisePrice} disabled={summaryLoading || actionSummary.revise_price === 0}
                  className="mt-3 w-full px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-40">
                  価格改定実行
                </button>
              </div>
              <div className="border rounded-lg p-4 bg-green-50 border-green-200">
                <p className="text-xs text-green-600 font-medium mb-1">積み上げ対象</p>
                <p className="text-2xl font-bold text-green-700">
                  {summaryLoading ? '…' : actionSummary.stack === null ? '—' : `${actionSummary.stack}件`}
                </p>
                <p className="text-xs text-green-500 mt-1">SOLD後に再出品可能な商品</p>
                <button onClick={handlePreviewStack} disabled={summaryLoading || actionSummary.stack === 0}
                  className="mt-3 w-full px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-40">
                  積み上げ実行
                </button>
              </div>
            </div>
          </div>

          {/* 手動データ取得 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-2">データ取得</h3>
            <p className="text-xs text-gray-500 mb-3">eBayのactiveリストを最新状態に更新します。自動同期がONの場合は毎朝9時に自動実行されます。</p>
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={handleSync} disabled={syncing || !settings.has_token}
                className={`px-4 py-2 text-sm rounded flex items-center gap-2 ${syncing || !settings.has_token ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}>
                {syncing ? '同期中...' : '🔄 eBay同期を今すぐ実行'}
              </button>
              <label className={`flex items-center gap-2 border rounded px-3 py-2 text-sm cursor-pointer ${uploading ? 'opacity-50 pointer-events-none bg-gray-50' : 'bg-white hover:bg-gray-50'}`}>
                <input type="file" accept=".csv,text/csv" className="hidden" ref={fileRef} onChange={handleUpload} disabled={uploading} />
                <span>📎</span>
                <span className="text-gray-600">{uploading ? 'アップロード中...' : 'activeファイルをアップロード'}</span>
              </label>
            </div>
            {!settings.has_token && <p className="text-xs text-red-500 mt-2">eBayトークン未設定のため同期は利用できません。設定タブからトークンを登録してください。</p>}
          </div>

          <hr />

          {/* 稼働スケジュール説明 */}
          <div className="bg-gray-50 border rounded p-4 text-xs text-gray-600 space-y-1">
            <p className="font-medium text-gray-700 mb-2">在庫管理稼働に関する各時間の説明</p>
            <p><strong>7時:</strong> 自動同期が有効になっている場合、7時に最新のactiveファイルを取得します。<span className="text-gray-400 ml-1">※この時間が過ぎると翌日のタイミングで在庫管理をすることになります。</span></p>
            <p><strong>9時:</strong> 自分でアクティブファイルをアップロードされる方は9時までにアップロードすると当日の在庫管理が可能です。<span className="text-gray-400 ml-1">※この時間が過ぎると翌日のタイミングとなります。</span></p>
            <p><strong>11時:</strong> 在庫管理の本番稼働前の状況確認。</p>
            <p><strong>13時:</strong> 在庫管理の本番稼働開始。9時段階でツールに存在する最新のactiveファイルを参照して在庫管理開始。</p>
          </div>

          {/* 実行履歴 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">実行履歴</h3>
              <button onClick={refreshRuns} className="px-2 py-1 border text-xs rounded text-gray-600 hover:bg-gray-50">
                更新
              </button>
            </div>
            <div className="overflow-x-auto">
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
                    <>
                      <tr key={run.id} className="border-b hover:bg-gray-50">
                        <td className="px-3 py-2 text-xs text-gray-600">{new Date(run.started_at).toLocaleString('ja-JP')}</td>
                        <td className="px-3 py-2 text-xs text-gray-600">{run.run_type === 'sync' ? 'eBay同期' : 'CSVアップロード'}</td>
                        <td className="px-3 py-2 text-xs text-gray-600 text-right">{run.items_total ?? '—'}</td>
                        <td className="px-3 py-2 text-xs text-gray-600 text-right">{run.items_matched ?? '—'}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${run.status === 'completed' ? 'bg-green-100 text-green-700' : run.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                              {run.status === 'completed' ? '稼働' : run.status === 'failed' ? '失敗' : '実行中'}
                            </span>
                            {run.status === 'failed' && run.error_message && (
                              <button onClick={() => setExpandedError(expandedError === run.id ? null : run.id)}
                                className="text-xs text-red-500 underline hover:text-red-700">
                                {expandedError === run.id ? '閉じる' : '詳細'}
                              </button>
                            )}
                          </div>
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
                      {expandedError === run.id && run.error_message && (
                        <tr className="bg-red-50">
                          <td colSpan={6} className="px-4 py-2 text-xs text-red-700 font-mono whitespace-pre-wrap">{run.error_message}</td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
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
          <p className="text-xs text-blue-700 font-medium border border-blue-200 bg-blue-50 rounded px-3 py-2">
            手動実行ボタンまたは自動実行トグルでeBayへの変更が実行されます。実行前に内容を必ずご確認ください。
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
            <h3 className="text-sm font-semibold text-gray-800 mb-1">eBay接続設定</h3>
            <p className="text-xs text-gray-500 mb-2">接続済みのeBayセラーが1件の場合は、そのOAuth認証を自動利用します。</p>
            <details className="mb-3">
              <summary className="text-xs text-blue-600 cursor-pointer hover:underline">トークンの取得方法</summary>
              <ol className="text-xs text-gray-600 mt-2 space-y-1 pl-4 list-decimal">
                <li><a href="https://developer.ebay.com/my/auth" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">eBay Developer Portal</a> にアクセス</li>
                <li>左メニューの「rakuraku Tool」アプリを選択 → 「User Tokens」リンクをクリック</li>
                <li>「OAuth (new security)」を選択</li>
                <li>「Sign in to Production for OAuth」をクリックしてeBayセラーアカウントでログイン</li>
                <li>表示された <code className="bg-gray-100 px-1 rounded">v^1.1#i^1#...</code> 形式のトークンを「Copy Token to Clipboard」でコピー</li>
                <li>下のAccess Token欄に貼り付けて「トークンを保存」</li>
              </ol>
            </details>
            {settings.has_token
              ? <p className="text-xs text-green-600 mb-2">✓ eBay認証設定済み{settings.ebay_token_expires_at ? `（手動トークン有効期限: ${new Date(settings.ebay_token_expires_at).toLocaleDateString('ja-JP')}）` : ''}</p>
              : <p className="text-xs text-red-500 mb-2">eBay認証未設定</p>}
            <EbayTokenForm hasToken={settings.has_token} onSaved={() => setSettings(prev => ({ ...prev, has_token: true }))} />
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
            <p className="text-xs text-gray-500 mb-3">eBayの出品開始日時から指定した日数が経過した商品を対象にします。出品開始日時が取得できない商品は対象外です。</p>
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
            <p className="text-xs text-gray-500">毎日1回、9時台（JST）に実行します。Vercel Hobbyプランでは実行時刻が9:00〜9:59の間で変動する場合があります。</p>
          </div>
          <hr />
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-3">自動実行設定</h3>
            <p className="text-xs text-gray-500 mb-3">ONにした機能は毎日9時台（JST）に自動で実行されます。実行前に対象件数を手動確認することを推奨します。</p>
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Toggle checked={settings.auto_delist} onChange={v => saveSetting({ auto_delist: v })} disabled={savingSettings || !settings.has_token} />
                <span className="text-sm text-gray-700 flex-1">取り下げを自動実行する</span>
                <button onClick={handlePreviewDelist} disabled={!settings.has_token}
                  className="px-3 py-1 border border-orange-500 text-orange-600 text-xs rounded hover:bg-orange-50 disabled:opacity-40">
                  今すぐ実行
                </button>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <Toggle checked={settings.auto_revise_price} onChange={v => saveSetting({ auto_revise_price: v })} disabled={savingSettings || !settings.has_token} />
                <span className="text-sm text-gray-700 flex-1">価格改定を自動実行する</span>
                <button onClick={handlePreviewRevisePrice} disabled={!settings.has_token}
                  className="px-3 py-1 border border-blue-500 text-blue-600 text-xs rounded hover:bg-blue-50 disabled:opacity-40">
                  今すぐ実行
                </button>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <Toggle checked={settings.auto_stack} onChange={v => saveSetting({ auto_stack: v })} disabled={savingSettings || !settings.has_token} />
                <span className="text-sm text-gray-700 flex-1">積み上げを自動実行する</span>
                <button onClick={handlePreviewStack} disabled={!settings.has_token}
                  className="px-3 py-1 border border-green-500 text-green-600 text-xs rounded hover:bg-green-50 disabled:opacity-40">
                  今すぐ実行
                </button>
              </div>
            </div>
            {!settings.has_token && <p className="text-xs text-red-500 mt-2">eBayトークンが設定されていないため自動実行は無効です。</p>}
          </div>
          <hr />
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">出品ポリシー設定（積み上げ用）</h3>
            <p className="text-xs text-gray-500 mb-3">積み上げ（新規出品）を使用する場合はeBayの出品ポリシー名を入力してください。</p>
            <div className="space-y-2">
              {([['payment_profile_name', '支払いポリシー名'], ['return_profile_name', '返品ポリシー名'], ['shipping_profile_name', '配送ポリシー名']] as const).map(([key, label]) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs text-gray-600 w-32">{label}</span>
                  <input type="text" value={settings[key]}
                    onChange={e => setSettings(prev => ({ ...prev, [key]: e.target.value }))}
                    onBlur={() => saveSetting({ [key]: settings[key] })}
                    placeholder={`例: ${label}`}
                    className="flex-1 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
              ))}
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
            <button onClick={handlePreviewStack}
              className="px-3 py-1.5 bg-green-600 text-white text-xs rounded hover:bg-green-700">
              積み上げ実行
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
                        {item.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element -- Marketplace image hosts are dynamic and cannot be safely allowlisted for next/image.
                          <img src={item.image_url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                        )}
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

      {/* ==================== アクション確認モーダル ==================== */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[80vh] flex flex-col">
            <h3 className="text-sm font-semibold text-gray-800 mb-1">
              {actionModal.type === 'delist' ? '取り下げ実行の確認' : actionModal.type === 'revise_price' ? '価格改定実行の確認' : '積み上げ実行の確認'}
            </h3>
            <p className="text-xs text-red-600 mb-3 font-medium">
              ⚠️ 実行するとeBayへ実際に変更が送信されます。内容を確認してから実行してください。
            </p>
            <p className="text-xs text-gray-500 mb-3">対象: {actionModal.items.length}件</p>
            <div className="overflow-y-auto flex-1 border rounded mb-4">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">アイテムID</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">タイトル</th>
                    {actionModal.type === 'revise_price' && <>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">現在価格</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">新価格</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">差分</th>
                    </>}
                    {actionModal.type === 'stack' && <th className="text-left px-3 py-2 font-medium text-gray-500">新仕入れURL</th>}
                  </tr>
                </thead>
                <tbody>
                  {actionModal.items.length === 0 ? (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400">対象商品がありません</td></tr>
                  ) : actionModal.items.map(item => (
                    <tr key={item.ebay_item_id} className="border-t">
                      <td className="px-3 py-2 text-blue-600">{item.ebay_item_id}</td>
                      <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate">{item.title ?? '—'}</td>
                      {actionModal.type === 'revise_price' && <>
                        <td className="px-3 py-2 text-right text-gray-600">${item.old_price?.toFixed(2)}</td>
                        <td className="px-3 py-2 text-right text-gray-800 font-medium">${item.new_price?.toFixed(2)}</td>
                        <td className={`px-3 py-2 text-right font-medium ${(item.diff ?? 0) > 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {(item.diff ?? 0) > 0 ? '+' : ''}{item.diff?.toFixed(2)}
                        </td>
                      </>}
                      {actionModal.type === 'stack' && (
                        <td className="px-3 py-2 text-blue-600 max-w-[200px] truncate">{item.new_source_url ?? '—'}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={handleRunAction} disabled={actionModal.running || actionModal.items.length === 0}
                className="px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50">
                {actionModal.running ? '実行中...' : `${actionModal.items.length}件を実行する`}
              </button>
              <button onClick={() => setActionModal(null)} disabled={actionModal.running}
                className="px-4 py-2 border text-sm rounded hover:bg-gray-50 disabled:opacity-50">
                キャンセル
              </button>
            </div>
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
