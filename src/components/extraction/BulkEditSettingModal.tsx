'use client'

import { useState } from 'react'
import type { BulkEditSetting } from '@/types/database'

interface Props {
  setting: BulkEditSetting | null
  onSaved: (setting: BulkEditSetting) => void
  onClose: () => void
}

function initialValue(value: number | null | undefined) {
  return value === null || value === undefined ? '' : String(value)
}

export default function BulkEditSettingModal({ setting, onSaved, onClose }: Props) {
  const [name, setName] = useState(setting?.name ?? '')
  const [titlePrefix, setTitlePrefix] = useState(setting?.title_prefix ?? '')
  const [titleSuffix, setTitleSuffix] = useState(setting?.title_suffix ?? '')
  const [profitRate, setProfitRate] = useState(initialValue(setting?.profit_rate))
  const [ebayFeeRate, setEbayFeeRate] = useState(initialValue(setting?.ebay_fee_rate))
  const [shippingCostJpy, setShippingCostJpy] = useState(initialValue(setting?.shipping_cost_jpy))
  const [fixedCostUsd, setFixedCostUsd] = useState(initialValue(setting?.fixed_cost_usd))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const inputClassName = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300'
  const optionalNumber = (value: string) => value === '' ? null : Number(value)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const response = await fetch('/api/bulk-edit-settings', {
        method: setting ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: setting?.id,
          name,
          title_prefix: titlePrefix,
          title_suffix: titleSuffix,
          profit_rate: optionalNumber(profitRate),
          ebay_fee_rate: optionalNumber(ebayFeeRate),
          shipping_cost_jpy: optionalNumber(shippingCostJpy),
          fixed_cost_usd: optionalNumber(fixedCostUsd),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? '保存に失敗しました')
      onSaved(data.setting)
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={save} className="w-full max-w-xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="font-semibold text-gray-900">一括編集設定{setting ? '編集' : '作成'}</h2>
          <button type="button" aria-label="閉じる" onClick={onClose} className="text-xl text-gray-400 hover:text-gray-700">&times;</button>
        </div>
        <div className="space-y-4 p-5">
          {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          <label className="block text-sm text-gray-700">
            設定名 <span className="text-red-500">*</span>
            <input required value={name} onChange={event => setName(event.target.value)} className={inputClassName} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm text-gray-700">タイトル接頭辞
              <input value={titlePrefix} onChange={event => setTitlePrefix(event.target.value)} className={inputClassName} />
            </label>
            <label className="block text-sm text-gray-700">タイトル接尾辞
              <input value={titleSuffix} onChange={event => setTitleSuffix(event.target.value)} className={inputClassName} />
            </label>
          </div>
          <div className="rounded border border-blue-100 bg-blue-50 p-4">
            <p className="mb-3 text-sm font-medium text-blue-900">抽出時の価格自動計算</p>
            <p className="mb-4 text-xs text-blue-700">空欄の場合は、利益率0.23・送料3,000円・eBay手数料率0.20・固定費0 USDで計算します。</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-gray-700">目標利益率
                <input type="number" min="0" max="0.99" step="0.01" placeholder="0.23" value={profitRate} onChange={event => setProfitRate(event.target.value)} className={inputClassName} />
              </label>
              <label className="block text-sm text-gray-700">eBay手数料率
                <input type="number" min="0" max="0.99" step="0.01" placeholder="0.20" value={ebayFeeRate} onChange={event => setEbayFeeRate(event.target.value)} className={inputClassName} />
              </label>
              <label className="block text-sm text-gray-700">送料（円）
                <input type="number" min="0" step="1" placeholder="3000" value={shippingCostJpy} onChange={event => setShippingCostJpy(event.target.value)} className={inputClassName} />
              </label>
              <label className="block text-sm text-gray-700">固定費（USD）
                <input type="number" min="0" step="0.01" placeholder="0" value={fixedCostUsd} onChange={event => setFixedCostUsd(event.target.value)} className={inputClassName} />
              </label>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t px-5 py-4">
          <button type="button" onClick={onClose} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">キャンセル</button>
          <button type="submit" disabled={saving || !name.trim()} className="rounded bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </form>
    </div>
  )
}
