'use client'

import { useEffect, useState } from 'react'
import { CalendarClock, Trash2 } from 'lucide-react'
import type { AutoExtractionProcessType } from '@/lib/auto-extraction-schedules'

interface SelectOption {
  id: string
  name: string
}

interface SellerOption {
  id: string
  seller_id: string
  display_name: string | null
  is_default: boolean
}

interface AutoExtractionSchedule {
  id: string
  name: string | null
  source_url: string
  seller_account_id: string | null
  category_id: string | null
  bulk_edit_setting_id: string | null
  process_type: AutoExtractionProcessType
  schedule_day_of_month: number
  schedule_time: string
  enabled: boolean
  created_at: string
  updated_at: string
  latest_run?: {
    id: string
    extraction_id: string | null
    status: 'completed' | 'skipped' | 'failed' | 'running'
    result_summary: {
      extracted: number
      ready_to_list?: number
      needs_fix?: number
    } | null
    error_message: string | null
    created_at: string
    finished_at: string | null
  } | null
}

interface Props {
  sellers: SellerOption[]
  categories: Array<SelectOption & { ebay_category_id: string | null }>
  bulkSettings: SelectOption[]
}

const inputClassName = 'w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400'

export default function AutoExtractionPageClient({ sellers, categories, bulkSettings }: Props) {
  const [schedules, setSchedules] = useState<AutoExtractionSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [sellerAccountId, setSellerAccountId] = useState(sellers.find(item => item.is_default)?.id ?? '')
  const [categoryId, setCategoryId] = useState('')
  const [bulkEditSettingId, setBulkEditSettingId] = useState('')
  const [processType, setProcessType] = useState<AutoExtractionProcessType>('extract')
  const [scheduleDay, setScheduleDay] = useState(1)
  const [scheduleTime, setScheduleTime] = useState('09:00')

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const res = await fetch('/api/auto-extraction-schedules')
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'スケジュールの取得に失敗しました')
        if (active) setSchedules(data.schedules ?? [])
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'スケジュールの取得に失敗しました')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!sourceUrl.trim()) return
    setSaving(true); setError(''); setNotice('')
    try {
      const res = await fetch('/api/auto-extraction-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          source_url: sourceUrl.trim(),
          seller_account_id: sellerAccountId || null,
          category_id: categoryId || null,
          bulk_edit_setting_id: bulkEditSettingId || null,
          process_type: processType,
          schedule_day_of_month: scheduleDay,
          schedule_time: scheduleTime,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '登録に失敗しました')
      setSchedules(current => [...current, data.schedule].sort((a, b) =>
        a.schedule_day_of_month - b.schedule_day_of_month || a.schedule_time.localeCompare(b.schedule_time)))
      setName(''); setSourceUrl('')
      setNotice('スケジュールを登録しました。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '登録に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function toggleEnabled(schedule: AutoExtractionSchedule) {
    setUpdatingId(schedule.id); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/auto-extraction-schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '更新に失敗しました')
      setSchedules(current => current.map(item => item.id === schedule.id ? data.schedule : item))
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新に失敗しました')
    } finally {
      setUpdatingId(null)
    }
  }

  async function deleteSchedule(schedule: AutoExtractionSchedule) {
    if (!window.confirm(`「${schedule.name || schedule.source_url}」を削除しますか？`)) return
    setUpdatingId(schedule.id); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/auto-extraction-schedules/${schedule.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '削除に失敗しました')
      setSchedules(current => current.filter(item => item.id !== schedule.id))
      setNotice('スケジュールを削除しました。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '削除に失敗しました')
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">自動抽出</h1>
        <p className="mt-1 text-sm text-gray-500">1ヶ月分の抽出スケジュールを登録・管理します。</p>
      </div>

      <div className="mb-6 rounded border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
        自動抽出は毎日9時台（日本時間）の定期処理で、当日分をまとめて実行します。設定した実行時刻は管理上の目安であり、その時刻ちょうどの実行を保証するものではありません。「抽出＋出品準備」を選ぶと出品可否を検証しますが、eBayへの出品は行いません。抽出結果を確認して手動で出品してください。
      </div>

      {error && <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">{notice}</div>}

      <form onSubmit={handleSubmit} className="mb-8 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-gray-800">新規スケジュール登録</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm text-gray-700">
            スケジュール名（任意）
            <input value={name} onChange={e => setName(e.target.value)} className={`mt-1 ${inputClassName}`} placeholder="例: 毎月のメルカリ抽出" />
          </label>
          <label className="text-sm text-gray-700">
            抽出対象URL <span className="text-red-500">*</span>
            <input type="url" required value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} className={`mt-1 ${inputClassName}`} placeholder="https://..." />
          </label>
          <label className="text-sm text-gray-700">
            出品セラー
            <select value={sellerAccountId} onChange={e => setSellerAccountId(e.target.value)} className={`mt-1 ${inputClassName}`}>
              <option value="">指定なし</option>
              {sellers.map(item => <option key={item.id} value={item.id}>{item.display_name || item.seller_id}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            カテゴリ
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)} className={`mt-1 ${inputClassName}`}>
              <option value="">指定なし</option>
              {categories.map(item => <option key={item.id} value={item.id}>{item.name}{item.ebay_category_id ? ` (${item.ebay_category_id})` : ''}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            一括編集設定
            <select value={bulkEditSettingId} onChange={e => setBulkEditSettingId(e.target.value)} className={`mt-1 ${inputClassName}`}>
              <option value="">指定なし</option>
              {bulkSettings.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            処理タイプ
            <select value={processType} onChange={e => setProcessType(e.target.value as AutoExtractionProcessType)} className={`mt-1 ${inputClassName}`}>
              <option value="extract">抽出のみ</option>
              <option value="extract_and_list">抽出＋出品準備（手動確認）</option>
            </select>
          </label>
          <label className="text-sm text-gray-700">
            実行日（毎月1〜28日）
            <input type="number" min={1} max={28} required value={scheduleDay} onChange={e => setScheduleDay(Number(e.target.value))} className={`mt-1 ${inputClassName}`} />
          </label>
          <label className="text-sm text-gray-700">
            実行時刻（目安）
            <input type="time" required value={scheduleTime} onChange={e => setScheduleTime(e.target.value)} className={`mt-1 ${inputClassName}`} />
          </label>
        </div>
        <div className="mt-5 flex justify-end">
          <button type="submit" disabled={saving || !sourceUrl.trim()} className="rounded bg-[#1c1c1c] px-5 py-2 text-sm font-medium text-white hover:bg-[#333] disabled:opacity-50">
            {saving ? '登録中...' : 'スケジュールを登録'}
          </button>
        </div>
      </form>

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 border-b px-5 py-4">
          <CalendarClock size={18} className="text-gray-500" />
          <h2 className="text-base font-semibold text-gray-800">登録済みスケジュール</h2>
        </div>
        {loading ? (
          <p className="px-5 py-10 text-center text-sm text-gray-400">読み込み中...</p>
        ) : schedules.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-400">登録済みのスケジュールはありません。</p>
        ) : (
          <div className="divide-y">
            {schedules.map(schedule => (
              <div key={schedule.id} className="flex flex-col gap-3 px-5 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-800">{schedule.name || '名称未設定'}</p>
                    <a href={schedule.source_url} target="_blank" rel="noopener noreferrer" className="block truncate text-sm text-blue-600 hover:underline">{schedule.source_url}</a>
                  </div>
                  <div className="text-sm text-gray-600 lg:w-48">{schedule.process_type === 'extract' ? '抽出のみ' : '抽出＋出品準備（手動確認）'}</div>
                  <div className="text-sm text-gray-600 lg:w-40">毎月{schedule.schedule_day_of_month}日 9時台実行（{schedule.schedule_time}は目安）</div>
                  <button type="button" role="switch" aria-checked={schedule.enabled} aria-label={`${schedule.name || schedule.source_url}を${schedule.enabled ? '無効' : '有効'}にする`}
                    disabled={updatingId === schedule.id} onClick={() => toggleEnabled(schedule)}
                    className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${schedule.enabled ? 'bg-green-500' : 'bg-gray-300'}`}>
                    <span className={`mt-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${schedule.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                  <span className={`text-xs font-medium lg:w-10 ${schedule.enabled ? 'text-green-600' : 'text-gray-400'}`}>{schedule.enabled ? '有効' : '無効'}</span>
                  <button type="button" aria-label={`${schedule.name || schedule.source_url}を削除`} disabled={updatingId === schedule.id}
                    onClick={() => deleteSchedule(schedule)} className="self-start rounded border border-red-300 p-2 text-red-500 hover:bg-red-50 disabled:opacity-50 lg:self-auto">
                    <Trash2 size={15} />
                  </button>
                </div>
                {schedule.latest_run && (
                  <div className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span>直近実行: {new Date(schedule.latest_run.finished_at ?? schedule.latest_run.created_at).toLocaleString('ja-JP')}</span>
                      <span>{schedule.latest_run.status === 'completed' ? '成功' : schedule.latest_run.status === 'skipped' ? 'スキップ' : schedule.latest_run.status === 'failed' ? '失敗' : '実行中'}</span>
                      {schedule.latest_run.result_summary && <span>抽出 {schedule.latest_run.result_summary.extracted}件</span>}
                      {schedule.process_type === 'extract_and_list' && schedule.latest_run.result_summary && (
                        <>
                          <span className="text-green-700">出品準備完了 {schedule.latest_run.result_summary.ready_to_list ?? 0}件</span>
                          <span className="text-amber-700">要確認 {schedule.latest_run.result_summary.needs_fix ?? 0}件</span>
                        </>
                      )}
                      {schedule.process_type === 'extract_and_list'
                        && (schedule.latest_run.result_summary?.ready_to_list ?? 0) > 0
                        && schedule.latest_run.extraction_id && (
                        <a href={`/extraction/${schedule.latest_run.extraction_id}`} className="font-medium text-blue-600 hover:underline">
                          抽出結果を確認して出品へ
                        </a>
                      )}
                    </div>
                    {schedule.latest_run.error_message && <p className="mt-1 text-red-600">{schedule.latest_run.error_message}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
