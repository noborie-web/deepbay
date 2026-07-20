'use client'

import { useState } from 'react'
import type { Product } from '@/types/database'
import { calcProfit, validateProfitParams, isSafePriceUsd } from '@/lib/pricing'

type PriceMode = 'fixed' | 'rate' | 'profit'

interface Props {
  products: Product[]
  pagedIds: Set<string>
  getPurchaseJpy: (p: Product) => number | null
  onApply: (getPrice: (p: Product) => number | null, scope: 'page' | 'all') => void
  onClose: () => void
}

export default function PriceEditModal({ products, pagedIds, getPurchaseJpy, onApply, onClose }: Props) {
  const [mode, setMode] = useState<PriceMode>('profit')
  const [scope, setScope] = useState<'page' | 'all'>('page')

  // fixed mode
  const [fixedPrice, setFixedPrice] = useState('')

  // rate mode — 初期値は空欄（ユーザーが入力するまで適用不可）
  const [rateMultiplier, setRateMultiplier] = useState('')

  // profit mode
  const [jpyPerUsd, setJpyPerUsd] = useState('150')
  const [ebayFeeRate, setEbayFeeRate] = useState('0.133')
  const [targetProfitRate, setTargetProfitRate] = useState('0.2')
  const [shippingUsd, setShippingUsd] = useState('15')
  const [fixedCostUsd, setFixedCostUsd] = useState('0')

  const targetProducts = scope === 'page'
    ? products.filter((p) => pagedIds.has(p.id))
    : products

  // 倍率・利益計算モードでは仕入価格が必要
  const needsPurchasePrice = mode === 'rate' || mode === 'profit'
  const missingPurchaseProducts = needsPurchasePrice
    ? targetProducts.filter((p) => {
        const jpy = getPurchaseJpy(p)
        return jpy == null || !isFinite(jpy) || jpy <= 0
      })
    : []
  const missingCount = missingPurchaseProducts.length
  const applicableCount = targetProducts.length - missingCount

  // モードごとのバリデーションエラー
  const fixedValidationError = mode === 'fixed'
    ? (!fixedPrice ? '価格を入力してください' : (!isSafePriceUsd(parseFloat(fixedPrice)) ? '0より大きい有限な数値を入力してください' : null))
    : null

  const rateValidationError = mode === 'rate'
    ? (!rateMultiplier ? '倍率を入力してください' : (!(parseFloat(rateMultiplier) > 0 && isFinite(parseFloat(rateMultiplier))) ? '0より大きい倍率を入力してください' : null))
    : null

  const profitValidationError = mode === 'profit' ? validateProfitParams({
    purchasePriceJpy: 1000,
    jpyPerUsd: parseFloat(jpyPerUsd),
    ebayFeeRate: parseFloat(ebayFeeRate),
    targetProfitRate: parseFloat(targetProfitRate),
    shippingUsd: parseFloat(shippingUsd),
    fixedCostUsd: parseFloat(fixedCostUsd),
  }) : null

  const applyDisabled = !!(fixedValidationError || rateValidationError || profitValidationError)
    || targetProducts.length === 0
    || missingCount > 0

  function getPriceForProduct(p: Product): number | null {
    if (mode === 'fixed') {
      const n = parseFloat(fixedPrice)
      return isSafePriceUsd(n) ? n : null
    }
    if (mode === 'rate') {
      const purchase = getPurchaseJpy(p)
      if (purchase == null || !isFinite(purchase) || purchase <= 0) return null
      const rate = parseFloat(rateMultiplier)
      if (!isFinite(rate) || rate <= 0) return null
      const price = Math.ceil(purchase * rate)
      return isSafePriceUsd(price) ? price : null
    }
    // profit mode
    const purchase = getPurchaseJpy(p)
    if (purchase == null || !isFinite(purchase) || purchase <= 0) return null
    const params = {
      purchasePriceJpy: purchase,
      jpyPerUsd: parseFloat(jpyPerUsd),
      ebayFeeRate: parseFloat(ebayFeeRate),
      targetProfitRate: parseFloat(targetProfitRate),
      shippingUsd: parseFloat(shippingUsd),
      fixedCostUsd: parseFloat(fixedCostUsd),
    }
    const err = validateProfitParams(params)
    if (err) return null
    const { salePriceUsd } = calcProfit(params)
    return isSafePriceUsd(salePriceUsd) ? salePriceUsd : null
  }

  const modeError = fixedValidationError ?? rateValidationError ?? profitValidationError

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">価格一括編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* モード選択 */}
          <div className="flex gap-4 border-b pb-4">
            {([['fixed', '固定ドル価格'], ['rate', '仕入 × 倍率'], ['profit', '利益計算']] as [PriceMode, string][]).map(([m, label]) => (
              <label key={m} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="radio" value={m} checked={mode === m} onChange={() => setMode(m)} />
                {label}
              </label>
            ))}
          </div>

          {/* 固定価格モード */}
          {mode === 'fixed' && (
            <div className="space-y-1">
              <label className="block space-y-1">
                <span className="text-xs text-gray-500">eBay販売価格（USD）</span>
                <div className="flex items-center gap-2">
                  <input type="number" value={fixedPrice} onChange={(e) => setFixedPrice(e.target.value)} min="0.01" step="0.01"
                    placeholder="例: 49.99"
                    className="border rounded px-3 py-1.5 text-sm w-32 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                  <span className="text-sm text-gray-500">$</span>
                </div>
              </label>
              {fixedValidationError && <p className="text-xs text-red-500">{fixedValidationError}</p>}
            </div>
          )}

          {/* 倍率モード */}
          {mode === 'rate' && (
            <div className="space-y-1">
              <label className="block space-y-1">
                <span className="text-xs text-gray-500">仕入価格（円）× 倍率 = eBay価格（$）</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">仕入価格 ×</span>
                  <input type="number" value={rateMultiplier} onChange={(e) => setRateMultiplier(e.target.value)} min="0.001" step="0.001"
                    placeholder="例: 0.08"
                    className="border rounded px-3 py-1.5 text-sm w-28 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </div>
              </label>
              {rateValidationError && <p className="text-xs text-red-500">{rateValidationError}</p>}
            </div>
          )}

          {/* 利益計算モード */}
          {mode === 'profit' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">1ドルあたりの円レート</span>
                  <input type="number" value={jpyPerUsd} onChange={(e) => setJpyPerUsd(e.target.value)} min="1" step="1"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">eBay手数料率（例: 0.133 = 13.3%）</span>
                  <input type="number" value={ebayFeeRate} onChange={(e) => setEbayFeeRate(e.target.value)} min="0" max="0.99" step="0.001"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">目標利益率（例: 0.2 = 20%）</span>
                  <input type="number" value={targetProfitRate} onChange={(e) => setTargetProfitRate(e.target.value)} min="0" max="0.99" step="0.001"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">海外送料（USD）</span>
                  <input type="number" value={shippingUsd} onChange={(e) => setShippingUsd(e.target.value)} min="0" step="0.5"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">固定費（USD）</span>
                  <input type="number" value={fixedCostUsd} onChange={(e) => setFixedCostUsd(e.target.value)} min="0" step="0.5"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
              </div>
              {profitValidationError && (
                <p className="text-xs text-red-500">{profitValidationError}</p>
              )}
            </div>
          )}

          {/* 適用範囲 */}
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-500">適用範囲:</span>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" value="page" checked={scope === 'page'} onChange={() => setScope('page')} />
              現在のページ
            </label>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="radio" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />
              抽出商品すべて
            </label>
          </div>

          {/* 仕入価格未設定の警告（倍率・利益計算モード） */}
          {needsPurchasePrice && targetProducts.length > 0 && (
            <div className="text-xs space-y-0.5">
              <p className="text-gray-600">適用可能: <span className="font-medium text-blue-600">{applicableCount}件</span></p>
              {missingCount > 0 && (
                <p className="text-amber-600">仕入価格未設定: {missingCount}件 — 仕入価格を設定してから適用してください</p>
              )}
            </div>
          )}

          {/* プレビュー */}
          {!applyDisabled && (
            <div>
              <p className="text-xs text-gray-500 mb-2">プレビュー（対象 {targetProducts.length} 件）</p>
              <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
                {targetProducts.slice(0, 10).map((p) => {
                  const jpy = getPurchaseJpy(p)
                  const usd = getPriceForProduct(p)
                  let profitLine = ''
                  if (mode === 'profit' && jpy != null) {
                    const params = {
                      purchasePriceJpy: jpy,
                      jpyPerUsd: parseFloat(jpyPerUsd),
                      ebayFeeRate: parseFloat(ebayFeeRate),
                      targetProfitRate: parseFloat(targetProfitRate),
                      shippingUsd: parseFloat(shippingUsd),
                      fixedCostUsd: parseFloat(fixedCostUsd),
                    }
                    if (!validateProfitParams(params)) {
                      const r = calcProfit(params)
                      profitLine = ` / 利益 $${r.profitUsd.toFixed(2)}`
                    }
                  }
                  return (
                    <div key={p.id} className="text-xs flex items-center gap-2">
                      <span className="text-gray-500 truncate max-w-[200px]">{p.original_title.slice(0, 30)}</span>
                      <span className="text-gray-400">仕入 {jpy != null ? `¥${jpy.toLocaleString()}` : '—'}</span>
                      <span className={usd != null ? 'text-blue-600 font-medium' : 'text-red-400'}>
                        {usd != null ? `$${usd.toFixed(2)}${profitLine}` : '計算不可'}
                      </span>
                    </div>
                  )
                })}
                {targetProducts.length > 10 && (
                  <p className="text-xs text-gray-400">…他 {targetProducts.length - 10} 件</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t">
          <div>
            {modeError && <p className="text-xs text-red-500">{modeError}</p>}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose}
              className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
            <button
              disabled={applyDisabled}
              onClick={() => { onApply(getPriceForProduct, scope); onClose() }}
              className="bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded px-4 py-2 text-sm font-medium">
              適用 ({needsPurchasePrice ? applicableCount : targetProducts.length}件)
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
