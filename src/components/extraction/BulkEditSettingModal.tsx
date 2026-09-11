'use client'

import { useState } from 'react'
import type { BulkEditSetting } from '@/types/database'

interface Props {
  setting: BulkEditSetting | null
  onSaved: (setting: BulkEditSetting) => void
  onClose: () => void
}

type Tab = 'basic' | 'exclusion'

function initialValue(value: number | null | undefined) {
  return value === null || value === undefined ? '' : String(value)
}

export default function BulkEditSettingModal({ setting, onSaved, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('basic')
  const [name, setName] = useState(setting?.name ?? '')
  const [memo, setMemo] = useState(setting?.memo ?? '')
  const [isDefault, setIsDefault] = useState(setting?.is_default ?? false)
  const [isEnabled, setIsEnabled] = useState(setting?.is_enabled ?? true)
  const [titlePrefix, setTitlePrefix] = useState(setting?.title_prefix ?? '')
  const [titleSuffix, setTitleSuffix] = useState(setting?.title_suffix ?? '')
  const [profitRate, setProfitRate] = useState(initialValue(setting?.profit_rate))
  const [ebayFeeRate, setEbayFeeRate] = useState(initialValue(setting?.ebay_fee_rate))
  const [shippingCostJpy, setShippingCostJpy] = useState(initialValue(setting?.shipping_cost_jpy))
  const [fixedCostUsd, setFixedCostUsd] = useState(initialValue(setting?.fixed_cost_usd))

  const [veroEnabled, setVeroEnabled] = useState(setting?.vero_exclude_enabled ?? true)
  const [dangerSellerEnabled, setDangerSellerEnabled] = useState(setting?.danger_seller_exclude_enabled ?? true)
  const [dangerWordEnabled, setDangerWordEnabled] = useState(setting?.danger_word_exclude_enabled ?? true)
  const [priceRangeEnabled, setPriceRangeEnabled] = useState(setting?.price_range_enabled ?? false)
  const [priceMin, setPriceMin] = useState(initialValue(setting?.price_min))
  const [priceMax, setPriceMax] = useState(initialValue(setting?.price_max))
  const [ratingEnabled, setRatingEnabled] = useState(setting?.rating_exclude_enabled ?? false)
  const [ratingMin, setRatingMin] = useState(initialValue(setting?.rating_min))
  const [shippingDaysEnabled, setShippingDaysEnabled] = useState(setting?.shipping_days_exclude_enabled ?? false)
  const [shippingDaysMax, setShippingDaysMax] = useState(initialValue(setting?.shipping_days_max))
  const [updatedMonthsEnabled, setUpdatedMonthsEnabled] = useState(setting?.updated_months_exclude_enabled ?? false)
  const [updatedMonthsAgo, setUpdatedMonthsAgo] = useState(initialValue(setting?.updated_months_ago))

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const inputClassName = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300'
  const optionalNumber = (value: string) => value === '' ? null : Number(value)

  async function copyId() {
    if (!setting?.id) return
    try {
      await navigator.clipboard.writeText(setting.id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // クリップボードAPIが使えない環境では静かに失敗する
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const response = await fetch('/api/bulk-edit-settings', {
        method: setting?.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: setting?.id,
          name,
          memo,
          is_default: isDefault,
          is_enabled: isEnabled,
          title_prefix: titlePrefix,
          title_suffix: titleSuffix,
          profit_rate: optionalNumber(profitRate),
          ebay_fee_rate: optionalNumber(ebayFeeRate),
          shipping_cost_jpy: optionalNumber(shippingCostJpy),
          fixed_cost_usd: optionalNumber(fixedCostUsd),
          vero_exclude_enabled: veroEnabled,
          danger_seller_exclude_enabled: dangerSellerEnabled,
          danger_word_exclude_enabled: dangerWordEnabled,
          price_range_enabled: priceRangeEnabled,
          price_min: optionalNumber(priceMin),
          price_max: optionalNumber(priceMax),
          rating_exclude_enabled: ratingEnabled,
          rating_min: optionalNumber(ratingMin),
          shipping_days_exclude_enabled: shippingDaysEnabled,
          shipping_days_max: optionalNumber(shippingDaysMax),
          updated_months_exclude_enabled: updatedMonthsEnabled,
          updated_months_ago: optionalNumber(updatedMonthsAgo),
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

  function toggleRow(label: string, enabled: boolean, onChange: (value: boolean) => void, children?: React.ReactNode) {
    return (
      <div className={`rounded border p-3 ${enabled ? 'border-red-200' : 'border-gray-200'}`}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-800">{label}</span>
          <button
            type="button"
            onClick={() => onChange(!enabled)}
            className={`rounded px-3 py-1 text-xs font-medium ${enabled ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}
          >
            {enabled ? '有効' : '無効'}
          </button>
        </div>
        {enabled && children && <div className="mt-3">{children}</div>}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={save} className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="font-semibold text-gray-900">一括編集設定{setting?.id ? '編集' : '作成'}</h2>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsEnabled((current) => !current)}
              className={`rounded px-3 py-1 text-xs font-medium ${isEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}
              title="この設定全体を使用するかどうかを切り替えます"
            >
              この設定{isEnabled ? '有効' : '無効'}
            </button>
            <button type="button" aria-label="閉じる" onClick={onClose} className="text-xl text-gray-400 hover:text-gray-700">&times;</button>
          </div>
        </div>

        <div className="flex gap-4 border-b px-5 text-sm">
          <button type="button" onClick={() => setTab('basic')} className={`border-b-2 px-1 py-2 ${tab === 'basic' ? 'border-gray-900 font-medium text-gray-900' : 'border-transparent text-gray-500'}`}>基本設定</button>
          <button type="button" onClick={() => setTab('exclusion')} className={`border-b-2 px-1 py-2 ${tab === 'exclusion' ? 'border-gray-900 font-medium text-gray-900' : 'border-transparent text-gray-500'}`}>除外設定</button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

          {tab === 'basic' && (
            <>
              {setting?.id && (
                <div className="text-sm text-gray-700">
                  一括編集ID
                  <div className="mt-1 flex items-center gap-2">
                    <code className="flex-1 truncate rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">{setting.id}</code>
                    <button type="button" onClick={copyId} className="rounded border px-2 py-2 text-xs hover:bg-gray-50">{copied ? 'コピー済み' : 'コピー'}</button>
                  </div>
                </div>
              )}
              <label className="block text-sm text-gray-700">
                設定名 <span className="text-red-500">*</span>
                <input required value={name} onChange={event => setName(event.target.value)} className={inputClassName} />
              </label>
              <label className="block text-sm text-gray-700">
                メモ
                <input value={memo} onChange={event => setMemo(event.target.value)} className={inputClassName} />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={isDefault} onChange={event => setIsDefault(event.target.checked)} />
                デフォルト使用設定
              </label>
              <p className="text-xs text-gray-500">この設定を有効にすると、次回ログイン時からこの設定が自動的に選択された状態になります</p>

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
            </>
          )}

          {tab === 'exclusion' && (
            <>
              <p className="text-xs font-medium text-red-600">セキュリティ除外設定</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {toggleRow('Veroワード除外', veroEnabled, setVeroEnabled)}
                {toggleRow('危険セラー除外', dangerSellerEnabled, setDangerSellerEnabled)}
                {toggleRow('危険単語除外', dangerWordEnabled, setDangerWordEnabled)}
              </div>

              <p className="pt-2 text-xs font-medium text-gray-500">商品フィルター設定</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {toggleRow('価格範囲', priceRangeEnabled, setPriceRangeEnabled, (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-gray-600">最低価格
                      <input type="number" min="0" value={priceMin} onChange={event => setPriceMin(event.target.value)} className={inputClassName} />
                    </label>
                    <label className="block text-xs text-gray-600">最高価格
                      <input type="number" min="0" value={priceMax} onChange={event => setPriceMax(event.target.value)} className={inputClassName} />
                    </label>
                  </div>
                ))}
                {toggleRow('合計評価数除外', ratingEnabled, setRatingEnabled, (
                  <label className="block text-xs text-gray-600">許容合計評価数（件未満で除外）
                    <input type="number" min="0" value={ratingMin} onChange={event => setRatingMin(event.target.value)} className={inputClassName} />
                  </label>
                ))}
              </div>

              <p className="pt-2 text-xs font-medium text-gray-500">時間・配送フィルター</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {toggleRow('最終更新', updatedMonthsEnabled, setUpdatedMonthsEnabled, (
                  <label className="block text-xs text-gray-600">許容月数（ヶ月以内）
                    <input type="number" min="0" value={updatedMonthsAgo} onChange={event => setUpdatedMonthsAgo(event.target.value)} className={inputClassName} />
                  </label>
                ))}
                {toggleRow('発送日数', shippingDaysEnabled, setShippingDaysEnabled, (
                  <label className="block text-xs text-gray-600">許容日数（日以内）
                    <input type="number" min="0" value={shippingDaysMax} onChange={event => setShippingDaysMax(event.target.value)} className={inputClassName} />
                  </label>
                ))}
              </div>
            </>
          )}
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
