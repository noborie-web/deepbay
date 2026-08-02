'use client'

import { useEffect, useState } from 'react'
import {
  DEFAULT_BULK_EDIT_CONFIG,
  normalizeBulkEditConfig,
  type BulkEditConfig,
  type BulkTargetField,
} from '@/lib/bulk-edit-settings'
import type { BulkEditSetting } from '@/types/database'

type Tab = 'basic' | 'exclusion' | 'filter'

const EMPTY_SETTING: Omit<BulkEditSetting, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
  name: '新しい設定',
  memo: '',
  is_default: false,
  config: DEFAULT_BULK_EDIT_CONFIG,
  price_rate: 1,
  title_prefix: '',
  title_suffix: '',
  description_template: '',
  condition_mapping: {},
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-5 w-5 accent-blue-600"
      />
      <span className={checked ? 'text-blue-700' : 'text-gray-500'}>
        {label ?? (checked ? '有効' : '無効')}
      </span>
    </label>
  )
}

function TargetFields({
  value,
  onChange,
}: {
  value: BulkTargetField[]
  onChange: (value: BulkTargetField[]) => void
}) {
  function toggle(field: BulkTargetField) {
    const next = value.includes(field)
      ? value.filter((item) => item !== field)
      : [...value, field]
    if (next.length > 0) onChange(next)
  }
  return (
    <div className="flex flex-wrap gap-4 text-sm">
      <span className="text-gray-500">チェック対象:</span>
      <label><input type="checkbox" checked={value.includes('title')} onChange={() => toggle('title')} /> 商品タイトル</label>
      <label><input type="checkbox" checked={value.includes('description')} onChange={() => toggle('description')} /> 商品詳細</label>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
  suffix?: string
}) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-500 mb-1">{label}</span>
      <div className="flex items-center border rounded bg-white">
        <input
          type="number"
          min="0"
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
          className="w-full px-3 py-2 rounded focus:outline-none"
        />
        {suffix && <span className="pr-3 text-sm text-gray-500 whitespace-nowrap">{suffix}</span>}
      </div>
    </label>
  )
}

export default function BulkEditSettingsPage() {
  const [settings, setSettings] = useState<BulkEditSetting[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<BulkEditSetting | null>(null)
  const [tab, setTab] = useState<Tab>('basic')
  const [newWord, setNewWord] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)

  async function load(preferredId?: string) {
    setLoading(true)
    try {
      const response = await fetch('/api/bulk-edit-settings')
      const data = await response.json()
      if (!response.ok) {
        setMessage(data.error ?? '設定の読み込みに失敗しました')
        return
      }
      const rows = (data.settings ?? []) as BulkEditSetting[]
      setSettings(rows)
      const requested = preferredId
        || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('id') : '')
        || ''
      const selected = rows.find((row) => row.id === requested)
        ?? rows.find((row) => row.is_default)
        ?? rows[0]
      setSelectedId(selected?.id ?? '')
      setDraft(selected ? { ...selected, config: normalizeBulkEditConfig(selected.config) } : null)
    } catch {
      setMessage('設定の読み込みに失敗しました。通信状態を確認して再試行してください。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // URLの初期値だけを使用する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function select(id: string) {
    const selected = settings.find((row) => row.id === id)
    setSelectedId(id)
    setDraft(selected ? { ...selected, config: normalizeBulkEditConfig(selected.config) } : null)
    setMessage('')
  }

  function updateConfig(patch: Partial<BulkEditConfig>) {
    setDraft((current) => current
      ? { ...current, config: { ...normalizeBulkEditConfig(current.config), ...patch } }
      : current)
  }

  async function create(copyCurrent: boolean) {
    setCreating(true)
    setMessage('')
    const source = copyCurrent && draft ? draft : null
    const payload = source
      ? { ...source, id: undefined, name: `${source.name} のコピー`, is_default: false }
      : EMPTY_SETTING
    try {
      const response = await fetch('/api/bulk-edit-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) return setMessage(data.error ?? '作成に失敗しました')
      setMessage('設定を作成しました')
      await load(data.setting.id)
    } catch {
      setMessage('作成に失敗しました。通信状態を確認して再試行してください。')
    } finally {
      setCreating(false)
    }
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch('/api/bulk-edit-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const data = await response.json()
      if (!response.ok) return setMessage(data.error ?? '保存に失敗しました')
      setMessage('保存しました。この設定は次回の抽出から適用されます。')
      await load(data.setting.id)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!draft || !window.confirm(`「${draft.name}」を削除しますか？`)) return
    const response = await fetch('/api/bulk-edit-settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: draft.id }),
    })
    const data = await response.json()
    if (!response.ok) return setMessage(data.error ?? '削除に失敗しました')
    setMessage('削除しました')
    await load()
  }

  if (!draft) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">一括編集設定</h1>
        <p className="text-gray-500 mb-4">{loading ? '設定を確認しています…' : '設定がまだありません。'}</p>
        {message && (
          <div className="mb-4 max-w-2xl rounded border border-red-300 bg-red-50 px-4 py-3 text-red-700">
            {message}
          </div>
        )}
        <button
          onClick={() => create(false)}
          disabled={loading || creating}
          className="border border-blue-500 text-blue-600 rounded px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? '作成中…' : '最初の設定を作成'}
        </button>
      </div>
    )
  }

  const config = normalizeBulkEditConfig(draft.config)
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap gap-3 items-end mb-5">
        <label className="flex-1 min-w-64">
          <span className="text-xs text-gray-500">一括編集設定選択</span>
          <select value={selectedId} onChange={(event) => select(event.target.value)} className="w-full border rounded px-3 py-2">
            {settings.map((setting) => <option key={setting.id} value={setting.id}>{setting.name}</option>)}
          </select>
        </label>
        <button onClick={() => create(false)} className="border border-blue-500 text-blue-600 rounded px-4 py-2">新規作成</button>
        <button onClick={() => create(true)} className="border border-blue-500 text-blue-600 rounded px-4 py-2">コピーして新規作成</button>
        <button onClick={remove} className="border border-red-300 text-red-500 rounded px-4 py-2">設定削除</button>
      </div>

      <div className="flex gap-6 border-b mb-6">
        {([
          ['basic', '基本設定'],
          ['exclusion', '除外設定'],
          ['filter', '編集設定'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`pb-2 ${tab === key ? 'border-b-2 border-blue-500 text-blue-600' : ''}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'basic' && (
        <div className="space-y-5">
          <div>
            <p className="text-sm font-medium mb-2">一括編集ID</p>
            <code className="text-sm">{draft.id}</code>
          </div>
          <label className="block">
            <span className="block text-sm font-medium mb-1">一括編集名</span>
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="w-full border rounded px-3 py-2" />
          </label>
          <label className="block">
            <span className="block text-sm font-medium mb-1">メモ</span>
            <input value={draft.memo ?? ''} onChange={(event) => setDraft({ ...draft, memo: event.target.value })} className="w-full border rounded px-3 py-2" />
          </label>
          <div>
            <p className="text-sm font-medium mb-2">デフォルト使用設定</p>
            <Toggle
              checked={draft.is_default}
              onChange={(is_default) => setDraft({ ...draft, is_default })}
              label={draft.is_default ? '次回から自動選択' : '自動選択しない'}
            />
          </div>
        </div>
      )}

      {tab === 'exclusion' && (
        <div className="space-y-5">
          <h2 className="text-lg font-semibold">セキュリティ除外設定</h2>
          <div className="grid md:grid-cols-3 gap-4">
            <section className="border rounded p-4 space-y-3">
              <h3 className="font-semibold">Veroワード除外</h3>
              <Toggle checked={config.veroEnabled} onChange={(veroEnabled) => updateConfig({ veroEnabled })} />
              <TargetFields value={config.veroTargetFields} onChange={(veroTargetFields) => updateConfig({ veroTargetFields })} />
              <p className="text-xs text-gray-500">抽出設定に登録されたVeroブランドを使用します。</p>
            </section>
            <section className="border border-red-300 rounded p-4 space-y-3">
              <h3 className="font-semibold text-red-700">危険セラー除外</h3>
              <Toggle checked={config.dangerSellerEnabled} onChange={(dangerSellerEnabled) => updateConfig({ dangerSellerEnabled })} />
              <p className="text-xs text-gray-500">各商品ページのセラーID・セラーURLを個別に照合します。</p>
            </section>
            <section className="border rounded p-4 space-y-3">
              <h3 className="font-semibold">危険単語除外</h3>
              <Toggle checked={config.dangerWordEnabled} onChange={(dangerWordEnabled) => updateConfig({ dangerWordEnabled })} />
              <TargetFields value={config.dangerWordTargetFields} onChange={(dangerWordTargetFields) => updateConfig({ dangerWordTargetFields })} />
            </section>
          </div>

          <section className="border rounded p-4 space-y-3">
            <div className="flex items-center gap-3">
              <h3 className="font-semibold">カスタムワード除外</h3>
              <span className="text-xs bg-gray-100 rounded-full px-2 py-1">{config.customWords.length}個登録</span>
            </div>
            <Toggle checked={config.customWordEnabled} onChange={(customWordEnabled) => updateConfig({ customWordEnabled })} />
            <TargetFields value={config.customWordTargetFields} onChange={(customWordTargetFields) => updateConfig({ customWordTargetFields })} />
            <div className="flex gap-2">
              <input value={newWord} onChange={(event) => setNewWord(event.target.value)} placeholder="除外ワード" className="border rounded px-3 py-2 flex-1" />
              <button
                onClick={() => {
                  const word = newWord.trim()
                  if (!word) return
                  updateConfig({ customWords: [...new Set([...config.customWords, word])] })
                  setNewWord('')
                }}
                className="border border-blue-400 text-blue-600 rounded px-4"
              >
                追加
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {config.customWords.map((word) => (
                <button
                  key={word}
                  onClick={() => updateConfig({ customWords: config.customWords.filter((item) => item !== word) })}
                  className="bg-gray-100 rounded-full px-3 py-1 text-sm"
                  title="クリックして削除"
                >
                  {word} ×
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === 'filter' && (
        <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-4">
          <section className="border rounded p-4 space-y-3">
            <h3 className="font-semibold">価格範囲</h3>
            <Toggle checked={config.priceRangeEnabled} onChange={(priceRangeEnabled) => updateConfig({ priceRangeEnabled })} />
            <NumberField label="最低価格" value={config.minPrice} onChange={(minPrice) => updateConfig({ minPrice })} suffix="円" />
            <NumberField label="最高価格" value={config.maxPrice} onChange={(maxPrice) => updateConfig({ maxPrice })} suffix="円" />
          </section>
          <section className="border rounded p-4 space-y-3">
            <h3 className="font-semibold">合計評価数除外</h3>
            <Toggle checked={config.ratingCountEnabled} onChange={(ratingCountEnabled) => updateConfig({ ratingCountEnabled })} />
            <NumberField label="必要な最低評価数" value={config.minRatingCount} onChange={(minRatingCount) => updateConfig({ minRatingCount })} suffix="件以上" />
          </section>
          <section className="border rounded p-4 space-y-3">
            <h3 className="font-semibold">低評価数</h3>
            <Toggle checked={config.lowRatingEnabled} onChange={(lowRatingEnabled) => updateConfig({ lowRatingEnabled })} />
            <NumberField label="許容低評価数" value={config.maxLowRatingCount} onChange={(maxLowRatingCount) => updateConfig({ maxLowRatingCount })} suffix="件以下" />
          </section>
          <section className="border rounded p-4 space-y-3">
            <h3 className="font-semibold">最終更新</h3>
            <Toggle checked={config.updatedWithinEnabled} onChange={(updatedWithinEnabled) => updateConfig({ updatedWithinEnabled })} />
            <NumberField label="許容月数" value={config.updatedWithinMonths} onChange={(updatedWithinMonths) => updateConfig({ updatedWithinMonths })} suffix="ヶ月以内" />
          </section>
          <section className="border rounded p-4 space-y-3">
            <h3 className="font-semibold">発送日数</h3>
            <Toggle checked={config.shippingDaysEnabled} onChange={(shippingDaysEnabled) => updateConfig({ shippingDaysEnabled })} />
            <NumberField label="許容日数" value={config.maxShippingDays} onChange={(maxShippingDays) => updateConfig({ maxShippingDays })} suffix="日以内" />
          </section>
        </div>
      )}

      <div className="mt-7">
        <button disabled={saving} onClick={save} className="w-full border border-green-500 text-green-600 rounded py-2 disabled:opacity-50">
          {saving ? '保存中...' : '保存'}
        </button>
        {message && <p className="text-center text-sm mt-2 text-gray-600">{message}</p>}
      </div>
    </div>
  )
}
