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

  // rate mode
  const [rateMultiplier, setRateMultiplier] = useState('0.1')

  // profit mode
  const [jpyPerUsd, setJpyPerUsd] = useState('150')
  const [ebayFeeRate, setEbayFeeRate] = useState('0.133')
  const [targetProfitRate, setTargetProfitRate] = useState('0.2')
  const [shippingUsd, setShippingUsd] = useState('15')
  const [fixedCostUsd, setFixedCostUsd] = useState('0')

  const targetProducts = scope === 'page'
    ? products.filter((p) => pagedIds.has(p.id))
    : products

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

  const profitValidationError = mode === 'profit' ? validateProfitParams({
    purchasePriceJpy: 1000,
    jpyPerUsd: parseFloat(jpyPerUsd),
    ebayFeeRate: parseFloat(ebayFeeRate),
    targetProfitRate: parseFloat(targetProfitRate),
    shippingUsd: parseFloat(shippingUsd),
    fixedCostUsd: parseFloat(fixedCostUsd),
  }) : null

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
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">eBay販売価格（USD）</span>
              <div className="flex items-center gap-2">
                <input type="number" value={fixedPrice} onChange={(e) => setFixedPrice(e.target.value)} min="0" step="0.01"
                  className="border rounded px-3 py-1.5 text-sm w-32 focus:outline-none focus:ring-1 focus:ring-blue-300" />
                <span className="text-sm text-gray-500">$</span>
              </div>
            </label>
          )}

          {/* 倍率モード */}
          {mode === 'rate' && (
            <label className="block space-y-1">
              <span className="text-xs text-gray-500">仕入価格（円）× 倍率 = eBay価格（$）</span>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">仕入価格 ×</span>
                <input type="number" value={rateMultiplier} onChange={(e) => setRateMultiplier(e.target.value)} min="0" step="0.001"
                  className="border rounded px-3 py-1.5 text-sm w-24 focus:outline-none focus:ring-1 focus:ring-blue-300" />
              </div>
            </label>
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

          {/* プレビュー */}
          <div>
            <p className="text-xs text-gray-500 mb-2">プレビュー（対象 {targetProducts.length} 件）</p>
            <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
              {targetProducts.slice(0, 10).map((p) => {
                const jpy = getPurchaseJpy(p)
                const usd = getPriceForProduct(p)
                let profitLine = ''
                if (mode === 'profit' && jpy != null && !profitValidationError) {
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
        </div>

        <div className="flex justify-end gap-3 px-5 py-4 border-t">
          <button onClick={onClose}
            className="border rounded px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">キャンセル</button>
          <button
            disabled={!!profitValidationError}
            onClick={() => { onApply(getPriceForProduct, scope); onClose() }}
            className="bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white rounded px-4 py-2 text-sm font-medium">
            適用 ({targetProducts.length}件)
          </button>
        </div>
      </div>
    </div>
  )
}
