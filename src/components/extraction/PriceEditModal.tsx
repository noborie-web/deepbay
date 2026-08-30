'use client'

import { useEffect, useRef, useState } from 'react'
import type { Product } from '@/types/database'
import {
  calcProfit,
  calcTieredProfit,
  findTierProfitJpy,
  isSafePriceUsd,
  validateProfitParams,
  validateProfitTiers,
  validateTieredProfitParams,
} from '@/lib/pricing'
import type { ProfitTier } from '@/lib/pricing'

type PriceMode = 'fixed' | 'rate' | 'profit' | 'tiered'

interface ProfitTierInput {
  id: string
  maxPurchaseJpy: string
  profitJpy: string
}

const INITIAL_PROFIT_TIERS: ProfitTierInput[] = [
  { id: 'tier-1', maxPurchaseJpy: '5000', profitJpy: '2000' },
  { id: 'tier-2', maxPurchaseJpy: '10000', profitJpy: '3000' },
  { id: 'tier-3', maxPurchaseJpy: '20000', profitJpy: '5000' },
  { id: 'tier-4', maxPurchaseJpy: '50000', profitJpy: '10000' },
  { id: 'tier-unlimited', maxPurchaseJpy: '', profitJpy: '15000' },
]

async function requestExchangeRate(): Promise<{ rate: number; date: string }> {
  const response = await fetch('/api/exchange-rate')
  const data: { rate?: unknown; date?: unknown } = await response.json()
  if (
    !response.ok
    || typeof data.rate !== 'number'
    || !isFinite(data.rate)
    || data.rate <= 0
    || typeof data.date !== 'string'
  ) {
    throw new Error('invalid exchange rate')
  }
  return { rate: data.rate, date: data.date }
}

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
  // 海外送料の入力は円で行い、計算時にその時点の為替レートでUSDへ変換する。
  const [shippingJpy, setShippingJpy] = useState('2000')
  const [fixedCostUsd, setFixedCostUsd] = useState('0')
  // 広告プロモーション率・関税率・ディスカウント率: いずれもeBay手数料率と
  // 同様に販売価格に対する割合として計算に反映する(pricing.ts参照)。
  const [adRate, setAdRate] = useState('0')
  const [customsRate, setCustomsRate] = useState('0')
  const [discountRate, setDiscountRate] = useState('0')
  const [profitTiers, setProfitTiers] = useState<ProfitTierInput[]>(INITIAL_PROFIT_TIERS)
  const [exchangeRateStatus, setExchangeRateStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [exchangeRateDate, setExchangeRateDate] = useState('')
  const [exchangeRateAdjusted, setExchangeRateAdjusted] = useState(false)
  const exchangeRateEditedRef = useRef(false)
  const nextTierIdRef = useRef(5)

  async function loadExchangeRate(force: boolean) {
    try {
      const data = await requestExchangeRate()
      if (force || !exchangeRateEditedRef.current) {
        setJpyPerUsd(data.rate.toFixed(2))
        exchangeRateEditedRef.current = false
        setExchangeRateAdjusted(false)
      }
      setExchangeRateDate(data.date)
      setExchangeRateStatus('success')
    } catch {
      setExchangeRateStatus('error')
    }
  }

  useEffect(() => {
    let cancelled = false
    requestExchangeRate()
      .then((data) => {
        if (cancelled) return
        if (!exchangeRateEditedRef.current) {
          setJpyPerUsd(data.rate.toFixed(2))
          setExchangeRateAdjusted(false)
        }
        setExchangeRateDate(data.date)
        setExchangeRateStatus('success')
      })
      .catch(() => {
        if (!cancelled) setExchangeRateStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  function updateExchangeRate(value: string) {
    exchangeRateEditedRef.current = true
    setExchangeRateAdjusted(true)
    setJpyPerUsd(value)
  }

  function updateTier(id: string, field: 'maxPurchaseJpy' | 'profitJpy', value: string) {
    setProfitTiers((current) => current.map((tier) => (
      tier.id === id ? { ...tier, [field]: value } : tier
    )))
  }

  function insertTierAfter(index: number) {
    const id = `tier-${nextTierIdRef.current}`
    nextTierIdRef.current += 1
    setProfitTiers((current) => {
      const insertAt = Math.min(index + 1, current.length - 1)
      return [
        ...current.slice(0, insertAt),
        { id, maxPurchaseJpy: '', profitJpy: '' },
        ...current.slice(insertAt),
      ]
    })
  }

  function addTier() {
    insertTierAfter(profitTiers.length - 2)
  }

  function removeTier(id: string) {
    setProfitTiers((current) => current.filter((tier) => tier.id !== id))
  }

  const parsedProfitTiers: ProfitTier[] = profitTiers.map((tier, index) => ({
    maxPurchaseJpy: index === profitTiers.length - 1
      ? null
      : parseFloat(tier.maxPurchaseJpy),
    profitJpy: parseFloat(tier.profitJpy),
  }))

  const targetProducts = scope === 'page'
    ? products.filter((p) => pagedIds.has(p.id))
    : products

  // 倍率・利益計算・価格帯別利益額モードでは仕入価格が必要
  const needsPurchasePrice = mode === 'rate' || mode === 'profit' || mode === 'tiered'
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

  // 入力欄は「4 = 4%」のパーセント表記のため、計算式が使う小数(0.04)に変換する。
  const parsedAdRate = parseFloat(adRate) / 100
  const parsedCustomsRate = parseFloat(customsRate) / 100
  const parsedDiscountRate = parseFloat(discountRate) / 100
  // 海外送料の入力は円のため、計算式が使うUSDへ為替レートで変換する。
  const parsedShippingUsd = parseFloat(shippingJpy) / parseFloat(jpyPerUsd)

  const profitValidationError = mode === 'profit' ? validateProfitParams({
    purchasePriceJpy: 1000,
    jpyPerUsd: parseFloat(jpyPerUsd),
    ebayFeeRate: parseFloat(ebayFeeRate),
    targetProfitRate: parseFloat(targetProfitRate),
    shippingUsd: parsedShippingUsd,
    fixedCostUsd: parseFloat(fixedCostUsd),
    adRate: parsedAdRate,
    customsRate: parsedCustomsRate,
    discountRate: parsedDiscountRate,
  }) : null

  const tierValidationError = mode === 'tiered'
    ? validateProfitTiers(parsedProfitTiers)
      ?? validateTieredProfitParams({
        purchasePriceJpy: 1000,
        profitJpy: parsedProfitTiers[0]?.profitJpy ?? NaN,
        jpyPerUsd: parseFloat(jpyPerUsd),
        ebayFeeRate: parseFloat(ebayFeeRate),
        shippingUsd: parsedShippingUsd,
        fixedCostUsd: parseFloat(fixedCostUsd),
        adRate: parsedAdRate,
        customsRate: parsedCustomsRate,
        discountRate: parsedDiscountRate,
      })
    : null

  const applyDisabled = !!(
    fixedValidationError
    || rateValidationError
    || profitValidationError
    || tierValidationError
  )
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
    if (mode === 'tiered') {
      const purchase = getPurchaseJpy(p)
      if (purchase == null || !isFinite(purchase) || purchase <= 0) return null
      const profitJpy = findTierProfitJpy(purchase, parsedProfitTiers)
      if (profitJpy === null) return null
      const params = {
        purchasePriceJpy: purchase,
        profitJpy,
        jpyPerUsd: parseFloat(jpyPerUsd),
        ebayFeeRate: parseFloat(ebayFeeRate),
        shippingUsd: parsedShippingUsd,
        fixedCostUsd: parseFloat(fixedCostUsd),
        adRate: parsedAdRate,
        customsRate: parsedCustomsRate,
        discountRate: parsedDiscountRate,
      }
      if (validateTieredProfitParams(params)) return null
      const { salePriceUsd } = calcTieredProfit(params)
      return isSafePriceUsd(salePriceUsd) ? salePriceUsd : null
    }
    // profit mode
    const purchase = getPurchaseJpy(p)
    if (purchase == null || !isFinite(purchase) || purchase <= 0) return null
    const params = {
      purchasePriceJpy: purchase,
      jpyPerUsd: parseFloat(jpyPerUsd),
      ebayFeeRate: parseFloat(ebayFeeRate),
      targetProfitRate: parseFloat(targetProfitRate),
      shippingUsd: parsedShippingUsd,
      fixedCostUsd: parseFloat(fixedCostUsd),
      adRate: parsedAdRate,
      customsRate: parsedCustomsRate,
      discountRate: parsedDiscountRate,
    }
    const err = validateProfitParams(params)
    if (err) return null
    const { salePriceUsd } = calcProfit(params)
    return isSafePriceUsd(salePriceUsd) ? salePriceUsd : null
  }

  const modeError = fixedValidationError
    ?? rateValidationError
    ?? profitValidationError
    ?? tierValidationError

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl mx-4 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="font-semibold text-gray-900">価格一括編集</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">&times;</button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* モード選択 */}
          <div className="flex flex-wrap gap-4 border-b pb-4">
            {([
              ['fixed', '固定ドル価格'],
              ['rate', '仕入 × 倍率'],
              ['profit', '利益計算'],
              ['tiered', '価格帯別利益額'],
            ] as [PriceMode, string][]).map(([m, label]) => (
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

          {/* 利益計算・価格帯別利益額モード */}
          {(mode === 'profit' || mode === 'tiered') && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">1ドルあたりの円レート</span>
                  <input
                    aria-label="1ドルあたりの円レート"
                    type="number"
                    value={jpyPerUsd}
                    onChange={(e) => updateExchangeRate(e.target.value)}
                    min="1"
                    step="0.01"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                  <span className={`block text-[11px] ${
                    exchangeRateStatus === 'error' ? 'text-amber-600' : 'text-gray-500'
                  }`}>
                    {exchangeRateStatus === 'loading' && '最新レートを取得中...'}
                    {exchangeRateStatus === 'success' && (
                      exchangeRateAdjusted
                        ? `${exchangeRateDate}時点の取得値から手動調整中`
                        : `${exchangeRateDate}時点の最新レートを自動取得`
                    )}
                    {exchangeRateStatus === 'error' && '自動取得できませんでした。手動入力値を使用します'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setExchangeRateStatus('loading')
                      void loadExchangeRate(true)
                    }}
                    disabled={exchangeRateStatus === 'loading'}
                    className="text-[11px] text-blue-600 hover:underline disabled:opacity-50"
                  >
                    最新レートを再取得
                  </button>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">eBay手数料率（例: 0.133 = 13.3%）</span>
                  <input type="number" value={ebayFeeRate} onChange={(e) => setEbayFeeRate(e.target.value)} min="0" max="0.99" step="0.001"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                {mode === 'profit' && (
                  <label className="block space-y-1">
                    <span className="text-xs text-gray-500">目標利益率（例: 0.2 = 20%）</span>
                    <input type="number" value={targetProfitRate} onChange={(e) => setTargetProfitRate(e.target.value)} min="0" max="0.99" step="0.001"
                      className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                  </label>
                )}
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">海外送料（円）</span>
                  <input aria-label="海外送料" type="number" value={shippingJpy} onChange={(e) => setShippingJpy(e.target.value)} min="0" step="100"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">固定費（USD）</span>
                  <input type="number" value={fixedCostUsd} onChange={(e) => setFixedCostUsd(e.target.value)} min="0" step="0.5"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">広告プロモーション率（%）（例: 4 = 4%）</span>
                  <input aria-label="広告プロモーション率" type="number" value={adRate} onChange={(e) => setAdRate(e.target.value)} min="0" max="99" step="0.1"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">関税率（%）（例: 4 = 4%）</span>
                  <input aria-label="関税率" type="number" value={customsRate} onChange={(e) => setCustomsRate(e.target.value)} min="0" max="99" step="0.1"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-gray-500">ディスカウント率（%）（例: 4 = 4%）</span>
                  <input aria-label="ディスカウント率" type="number" value={discountRate} onChange={(e) => setDiscountRate(e.target.value)} min="0" max="99" step="0.1"
                    className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-300" />
                </label>
              </div>

              {mode === 'tiered' && (
                <div className="border rounded-lg p-3 space-y-2 bg-gray-50">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-gray-700">仕入価格帯ごとの希望利益額</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        手数料・送料・固定費を差し引いた後に残したい利益を円で設定します。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={addTier}
                      className="border border-blue-400 text-blue-600 rounded px-2.5 py-1 text-xs hover:bg-blue-50 shrink-0"
                    >
                      ＋末尾に行を追加
                    </button>
                  </div>
                  <div className="grid grid-cols-[1fr_1fr_72px] gap-2 px-1 text-[11px] text-gray-500">
                    <span>仕入価格の上限（円）</span>
                    <span>希望利益額（円）</span>
                    <span className="text-center">行操作</span>
                  </div>
                  {profitTiers.map((tier, index) => {
                    const isLast = index === profitTiers.length - 1
                    return (
                      <div key={tier.id} className="grid grid-cols-[1fr_1fr_72px] gap-2 items-center">
                        {isLast ? (
                          <div className="border rounded px-3 py-1.5 text-sm bg-white text-gray-500">上限なし</div>
                        ) : (
                          <input
                            aria-label={`仕入上限 ${index + 1}`}
                            type="number"
                            min="1"
                            step="100"
                            value={tier.maxPurchaseJpy}
                            onChange={(event) => updateTier(tier.id, 'maxPurchaseJpy', event.target.value)}
                            placeholder="例: 10000"
                            className="border rounded px-3 py-1.5 text-sm"
                          />
                        )}
                        <input
                          aria-label={`希望利益額 ${index + 1}`}
                          type="number"
                          min="0"
                          step="100"
                          value={tier.profitJpy}
                          onChange={(event) => updateTier(tier.id, 'profitJpy', event.target.value)}
                          placeholder="例: 3000"
                          className="border rounded px-3 py-1.5 text-sm"
                        />
                        <div className="flex items-center justify-center gap-1">
                          {!isLast && (
                            <button
                              type="button"
                              aria-label={`価格帯${index + 1}の下に行を追加`}
                              title="この下に行を追加"
                              onClick={() => insertTierAfter(index)}
                              className="w-7 h-7 border border-blue-400 text-blue-600 rounded hover:bg-blue-50 text-base leading-none"
                            >
                              ＋
                            </button>
                          )}
                          {!isLast && profitTiers.length > 2 ? (
                            <button
                              type="button"
                              aria-label={`価格帯${index + 1}を削除`}
                              title="この行を削除"
                              onClick={() => removeTier(tier.id)}
                              className="w-7 h-7 text-gray-400 hover:text-red-500 text-lg leading-none"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {(profitValidationError || tierValidationError) && (
                <p className="text-xs text-red-500">
                  {profitValidationError ?? tierValidationError}
                </p>
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

          {/* 仕入価格未設定の警告 */}
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
                      shippingUsd: parsedShippingUsd,
                      fixedCostUsd: parseFloat(fixedCostUsd),
                      adRate: parsedAdRate,
                      customsRate: parsedCustomsRate,
                      discountRate: parsedDiscountRate,
                    }
                    if (!validateProfitParams(params)) {
                      const r = calcProfit(params)
                      profitLine = ` / 利益 $${r.profitUsd.toFixed(2)}`
                    }
                  }
                  if (mode === 'tiered' && jpy != null) {
                    const profitJpy = findTierProfitJpy(jpy, parsedProfitTiers)
                    if (profitJpy !== null) {
                      const params = {
                        purchasePriceJpy: jpy,
                        profitJpy,
                        jpyPerUsd: parseFloat(jpyPerUsd),
                        ebayFeeRate: parseFloat(ebayFeeRate),
                        shippingUsd: parsedShippingUsd,
                        fixedCostUsd: parseFloat(fixedCostUsd),
                        adRate: parsedAdRate,
                        customsRate: parsedCustomsRate,
                        discountRate: parsedDiscountRate,
                      }
                      if (!validateTieredProfitParams(params)) {
                        const result = calcTieredProfit(params)
                        profitLine = ` / 利益 $${result.profitUsd.toFixed(2)}（目標 ¥${profitJpy.toLocaleString()}）`
                      }
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
