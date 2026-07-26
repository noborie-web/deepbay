'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { getDirectListingIssues, getListingIssues } from '@/lib/listing-export'
import type { EbayPolicySet } from '@/lib/ebay'
import type { Extraction, Product, SellerAccount } from '@/types/database'

interface Props {
  extraction: Extraction
  sellers: SellerAccount[]
  onClose: () => void
}

const DEFAULT_POLICIES = {
  shipping: '3area excluded ver.',
  payment: 'eBay Payments',
  returns: 'Returns Accepted,Buyer,60 Days,Money Back',
}

interface DirectListingResponse {
  ok: boolean
  succeeded: Array<{ productId: string; itemId: string; warnings: string[] }>
  failed: Array<{ productId: string; error: string }>
  requested: number
}

function filenameFromResponse(response: Response, fallback: string): string {
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="([^"]+)"/)
  return match?.[1] ?? fallback
}

export default function ListingModal({ extraction, sellers, onClose }: Props) {
  const initialSellerId = extraction.seller_account_id
    ?? sellers.find((seller) => seller.is_default)?.id
    ?? sellers[0]?.id
    ?? ''
  const initialSeller = sellers.find((seller) => seller.id === initialSellerId)
  const [sellerAccountId, setSellerAccountId] = useState(initialSellerId)
  const [manualSellerId, setManualSellerId] = useState(extraction.seller_account?.seller_id ?? '')
  const [shippingProfile, setShippingProfile] = useState(DEFAULT_POLICIES.shipping)
  const [paymentProfile, setPaymentProfile] = useState(DEFAULT_POLICIES.payment)
  const [returnProfile, setReturnProfile] = useState(DEFAULT_POLICIES.returns)
  const [policyMode, setPolicyMode] = useState<'ebay' | 'manual'>(
    initialSeller?.ebay_connected_at ? 'ebay' : 'manual',
  )
  const [ebayPolicies, setEbayPolicies] = useState<EbayPolicySet | null>(null)
  const [loadingPolicies, setLoadingPolicies] = useState(Boolean(initialSeller?.ebay_connected_at))
  const [policyError, setPolicyError] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [downloading, setDownloading] = useState<'listing' | 'specifics' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showDirectConfirmation, setShowDirectConfirmation] = useState(false)
  const [directConfirmed, setDirectConfirmed] = useState(false)
  const [directRunning, setDirectRunning] = useState(false)
  const [directProgress, setDirectProgress] = useState({ completed: 0, total: 0 })

  useEffect(() => {
    let active = true
    fetch(`/api/products/${extraction.id}`)
      .then(async (response) => {
        const json = await response.json()
        if (!response.ok) throw new Error(json.error ?? '商品情報の取得に失敗しました')
        if (active) setProducts(json)
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : '商品情報の取得に失敗しました')
      })
      .finally(() => {
        if (active) setLoadingProducts(false)
      })
    return () => { active = false }
  }, [extraction.id])

  const categoryId = extraction.category?.ebay_category_id ?? null
  const invalidProducts = useMemo(
    () => products
      .map((product) => ({ product, issues: getListingIssues(product, categoryId) }))
      .filter((item) => item.issues.length > 0),
    [products, categoryId],
  )
  const directInvalidProducts = useMemo(
    () => products
      .filter((product) => product.listing_status === 'draft')
      .map((product) => ({ product, issues: getDirectListingIssues(product, categoryId) }))
      .filter((item) => item.issues.length > 0),
    [products, categoryId],
  )
  const directTargetProducts = useMemo(
    () => products.filter((product) => product.listing_status === 'draft'),
    [products],
  )
  const sellerMismatch = Boolean(
    extraction.seller_account_id && sellerAccountId !== extraction.seller_account_id,
  )
  const selectedSeller = sellers.find((seller) => seller.id === sellerAccountId)
  const sellerConnected = Boolean(selectedSeller?.ebay_connected_at)
  const sellerId = selectedSeller?.seller_id ?? manualSellerId.trim()
  const sellerReady = Boolean(sellerId)
  const selectedPoliciesExist = policyMode === 'manual' || Boolean(
    ebayPolicies?.fulfillment.some((policy) => policy.name === shippingProfile)
    && ebayPolicies.payment.some((policy) => policy.name === paymentProfile)
    && ebayPolicies.return.some((policy) => policy.name === returnProfile),
  )
  const policiesReady = Boolean(
    shippingProfile.trim()
    && paymentProfile.trim()
    && returnProfile.trim()
    && selectedPoliciesExist
    && (policyMode === 'manual' || (!loadingPolicies && !policyError)),
  )
  const canDownloadListing = !loadingProducts
    && products.length > 0
    && invalidProducts.length === 0
    && !sellerMismatch
    && sellerReady
    && policiesReady
    && !downloading
    && !directRunning
  const canDirectListing = canDownloadListing
    && sellerConnected
    && policyMode === 'ebay'
    && directTargetProducts.length > 0
    && directInvalidProducts.length === 0

  const loadEbayPolicies = useCallback(async (forceRefresh = false) => {
    if (!sellerAccountId || !sellerConnected) return
    try {
      const params = new URLSearchParams({ sellerAccountId })
      if (forceRefresh) params.set('refresh', '1')
      const response = await fetch(`/api/ebay/policies?${params.toString()}`, {
        cache: 'no-store',
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? 'eBayポリシーの取得に失敗しました')
      const policies = json as EbayPolicySet
      setEbayPolicies(policies)
      const missingPolicyTypes = [
        policies.fulfillment.length === 0 ? '配送' : '',
        policies.payment.length === 0 ? '支払' : '',
        policies.return.length === 0 ? '返品' : '',
      ].filter(Boolean)
      if (missingPolicyTypes.length > 0) {
        setPolicyError(
          `eBayに${missingPolicyTypes.join('・')}ポリシーがありません。eBay側で作成後、再同期してください。`,
        )
      } else {
        setPolicyError('')
      }
      setShippingProfile((current) => (
        policies.fulfillment.some((policy) => policy.name === current)
          ? current
          : policies.fulfillment[0]?.name ?? ''
      ))
      setPaymentProfile((current) => (
        policies.payment.some((policy) => policy.name === current)
          ? current
          : policies.payment[0]?.name ?? ''
      ))
      setReturnProfile((current) => (
        policies.return.some((policy) => policy.name === current)
          ? current
          : policies.return[0]?.name ?? ''
      ))
    } catch (caught) {
      setPolicyError(caught instanceof Error ? caught.message : 'eBayポリシーの取得に失敗しました')
    } finally {
      setLoadingPolicies(false)
    }
  }, [sellerAccountId, sellerConnected])

  function syncEbayPolicies() {
    setLoadingPolicies(true)
    setPolicyError('')
    void loadEbayPolicies(true)
  }

  useEffect(() => {
    if (!sellerConnected) return
    const timeout = window.setTimeout(() => {
      void loadEbayPolicies()
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [loadEbayPolicies, sellerConnected])

  function changeSellerAccount(nextSellerAccountId: string) {
    const nextSeller = sellers.find((seller) => seller.id === nextSellerAccountId)
    setSellerAccountId(nextSellerAccountId)
    setEbayPolicies(null)
    setPolicyError('')
    if (nextSeller?.ebay_connected_at) {
      setPolicyMode('ebay')
      setLoadingPolicies(true)
    } else {
      setPolicyMode('manual')
      setLoadingPolicies(false)
      setShippingProfile(DEFAULT_POLICIES.shipping)
      setPaymentProfile(DEFAULT_POLICIES.payment)
      setReturnProfile(DEFAULT_POLICIES.returns)
    }
  }

  function connectEbay() {
    const returnParams = new URLSearchParams(window.location.search)
    returnParams.set('openListing', extraction.id)
    const returnTo = `${window.location.pathname}?${returnParams.toString()}`
    const connectParams = new URLSearchParams({ returnTo })
    if (sellerAccountId) connectParams.set('sellerAccountId', sellerAccountId)
    window.location.assign(`/api/ebay/oauth/start?${connectParams.toString()}`)
  }
  const canDownloadSpecifics = !loadingProducts
    && products.length > 0
    && !sellerMismatch
    && sellerReady
    && policiesReady
    && !downloading

  async function downloadCsv(kind: 'listing' | 'specifics') {
    setError('')
    setNotice('')
    setDownloading(kind)
    try {
      const params = new URLSearchParams({
        extractionId: extraction.id,
        sellerId,
      })
      if (sellerAccountId) params.set('sellerAccountId', sellerAccountId)
      params.set('shippingProfile', shippingProfile.trim())
      params.set('paymentProfile', paymentProfile.trim())
      params.set('returnProfile', returnProfile.trim())
      if (kind === 'listing') {
        params.set('formatVersion', 'ebay-upload-42-v1')
        params.set('requestId', crypto.randomUUID())
      } else {
        params.set('formatVersion', 'specificsin-45-v1')
        // 過去の3列レスポンスがブラウザや中継キャッシュに残っていても再利用させない。
        params.set('requestId', crypto.randomUUID())
      }
      const path = kind === 'listing' ? '/api/csv' : '/api/csv/specifics'
      const response = await fetch(`${path}?${params.toString()}`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error ?? 'CSV出力に失敗しました')
      }
      if (kind === 'listing') {
        const format = response.headers.get('X-Ebay-Upload-Format')
        const columns = response.headers.get('X-Ebay-Upload-Columns')
        if (format !== '42-columns-v1' || columns !== '42') {
          throw new Error(
            '旧形式の出品CSVが返されたためダウンロードを中止しました。画面を再読み込みしてください。',
          )
        }
      } else {
        const format = response.headers.get('X-Specifics-In-Format')
        const columns = response.headers.get('X-Specifics-In-Columns')
        if (format !== '45-columns-v1' || columns !== '45') {
          throw new Error(
            '旧形式のCSVが返されたためダウンロードを中止しました。画面を再読み込みしてください。',
          )
        }
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filenameFromResponse(
        response,
        kind === 'listing' ? 'ebay_listing.csv' : 'ebay_specifics.csv',
      )
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setNotice(kind === 'listing'
        ? '出品CSVを出力しました。選択したセラーのeBayへアップロードしてください。'
        : 'Specifics-IN 45列CSVを出力しました。')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV出力に失敗しました')
    } finally {
      setDownloading(null)
    }
  }

  async function publishDirectly() {
    if (!canDirectListing || !directConfirmed) return
    setError('')
    setNotice('')
    setDirectRunning(true)
    setDirectProgress({ completed: 0, total: directTargetProducts.length })
    const succeeded: DirectListingResponse['succeeded'] = []
    const failed: DirectListingResponse['failed'] = []
    try {
      for (let offset = 0; offset < directTargetProducts.length; offset += 20) {
        const chunk = directTargetProducts.slice(offset, offset + 20)
        const response = await fetch('/api/ebay/listings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            extractionId: extraction.id,
            sellerAccountId,
            productIds: chunk.map((product) => product.id),
            shippingProfile,
            paymentProfile,
            returnProfile,
            confirmed: true,
          }),
        })
        const json = await response.json() as Partial<DirectListingResponse> & { error?: string }
        if (!response.ok && !Array.isArray(json.failed)) {
          throw new Error(json.error ?? 'eBayへのダイレクト出品に失敗しました')
        }
        succeeded.push(...(json.succeeded ?? []))
        failed.push(...(json.failed ?? []))
        setDirectProgress({
          completed: Math.min(offset + chunk.length, directTargetProducts.length),
          total: directTargetProducts.length,
        })
      }
      const succeededIds = new Set(succeeded.map((item) => item.productId))
      setProducts((current) => current.map((product) => (
        succeededIds.has(product.id)
          ? {
            ...product,
            listing_status: 'listed',
            listed_at: new Date().toISOString(),
            ebay_item_id: succeeded.find((item) => item.productId === product.id)?.itemId ?? null,
          }
          : product
      )))
      if (failed.length > 0) {
        setError(
          `${succeeded.length}件を出品、${failed.length}件が失敗しました。`
          + ` ${failed.slice(0, 3).map((item) => item.error).join(' / ')}`,
        )
      } else {
        setNotice(`${succeeded.length}件をeBayへ出品しました。`)
      }
      setShowDirectConfirmation(false)
      setDirectConfirmed(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'eBayへのダイレクト出品に失敗しました')
    } finally {
      setDirectRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/45 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="listing-modal-title"
        className="bg-white w-full max-w-5xl max-h-[92vh] rounded-xl shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-5 border-b">
          <h2 id="listing-modal-title" className="text-xl font-bold">出品セラー選択</h2>
          <button aria-label="出品画面を閉じる" onClick={onClose} className="p-2 text-gray-500 hover:text-gray-900">
            <X size={22} />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 space-y-5">
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3">
            <p className="font-bold text-red-600">
              CSV出品では、必ず選択したセラー用に出力したファイルをアップロードしてください。
            </p>
            <p className="text-sm text-gray-700 mt-1">
              抽出時と異なるセラーは選択できません。商品と在庫管理の紐付けを保護します。
            </p>
          </div>

          {sellers.length > 0 ? (
            <label className="block">
              <span className="text-sm text-gray-500">出品セラー</span>
              <select
                aria-label="出品セラー"
                value={sellerAccountId}
                onChange={(event) => changeSellerAccount(event.target.value)}
                className="mt-1 w-full border rounded-lg px-3 py-3"
              >
                {sellers.map((seller) => (
                  <option key={seller.id} value={seller.id}>
                    {seller.display_name || seller.seller_id}
                    {seller.ebay_connected_at ? '（eBay接続済み）' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block">
              <span className="text-sm text-gray-500">eBayセラーID</span>
              <input
                aria-label="eBayセラーID"
                value={manualSellerId}
                onChange={(event) => setManualSellerId(event.target.value)}
                placeholder="例: miyabi-24"
                className="mt-1 w-full border rounded-lg px-3 py-3"
              />
              <span className="text-xs text-amber-600">
                登録済みセラーがないため手入力です。CSVをアップロードするeBayアカウントと一致させてください。
              </span>
            </label>
          )}

          <div className="rounded-lg border px-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block flex-1 min-w-64">
                <span className="text-sm text-gray-500">出品ポリシー選択方法</span>
                <select
                  aria-label="出品ポリシー選択方法"
                  value={policyMode}
                  onChange={(event) => setPolicyMode(event.target.value as 'ebay' | 'manual')}
                  className="mt-1 w-full border rounded-lg px-3 py-3"
                >
                  {sellerConnected && <option value="ebay">eBayから取得したポリシー</option>}
                  <option value="manual">手動設定</option>
                </select>
              </label>
              {sellerConnected ? (
                <button
                  type="button"
                  onClick={syncEbayPolicies}
                  disabled={loadingPolicies}
                  className="border border-blue-400 text-blue-600 rounded-lg px-4 py-3 hover:bg-blue-50 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  <RefreshCw size={16} className={loadingPolicies ? 'animate-spin' : ''} />
                  eBayと再同期
                </button>
              ) : (
                <button
                  type="button"
                  onClick={connectEbay}
                  className="bg-blue-600 text-white rounded-lg px-4 py-3 hover:bg-blue-700"
                >
                  eBayアカウントを接続
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {sellerConnected
                ? `${selectedSeller?.seller_id} / ${selectedSeller?.ebay_marketplace_id || 'EBAY_US'} のビジネスポリシーを使用します。`
                : '接続すると、eBayに登録済みの配送・支払・返品ポリシーを安全に取得して選択できます。'}
            </p>
            {policyError && <p className="text-xs text-red-600 mt-2">{policyError}</p>}
          </div>

          <section>
            <h3 className="text-lg font-bold mb-3">出品ポリシー選択</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <label>
                <span className="text-sm text-gray-500">配送ポリシー</span>
                {policyMode === 'ebay' ? (
                  <select
                    aria-label="配送ポリシー"
                    value={shippingProfile}
                    onChange={(event) => setShippingProfile(event.target.value)}
                    disabled={loadingPolicies || !ebayPolicies?.fulfillment.length}
                    className="mt-1 w-full border rounded-lg px-3 py-3 disabled:bg-gray-50"
                  >
                    {(ebayPolicies?.fulfillment ?? []).map((policy) => (
                      <option key={policy.id} value={policy.name}>{policy.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="配送ポリシー"
                    value={shippingProfile}
                    onChange={(event) => setShippingProfile(event.target.value)}
                    className="mt-1 w-full border rounded-lg px-3 py-3"
                  />
                )}
              </label>
              <label>
                <span className="text-sm text-gray-500">支払ポリシー</span>
                {policyMode === 'ebay' ? (
                  <select
                    aria-label="支払ポリシー"
                    value={paymentProfile}
                    onChange={(event) => setPaymentProfile(event.target.value)}
                    disabled={loadingPolicies || !ebayPolicies?.payment.length}
                    className="mt-1 w-full border rounded-lg px-3 py-3 disabled:bg-gray-50"
                  >
                    {(ebayPolicies?.payment ?? []).map((policy) => (
                      <option key={policy.id} value={policy.name}>{policy.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="支払ポリシー"
                    value={paymentProfile}
                    onChange={(event) => setPaymentProfile(event.target.value)}
                    className="mt-1 w-full border rounded-lg px-3 py-3"
                  />
                )}
              </label>
              <label>
                <span className="text-sm text-gray-500">返品ポリシー</span>
                {policyMode === 'ebay' ? (
                  <select
                    aria-label="返品ポリシー"
                    value={returnProfile}
                    onChange={(event) => setReturnProfile(event.target.value)}
                    disabled={loadingPolicies || !ebayPolicies?.return.length}
                    className="mt-1 w-full border rounded-lg px-3 py-3 disabled:bg-gray-50"
                  >
                    {(ebayPolicies?.return ?? []).map((policy) => (
                      <option key={policy.id} value={policy.name}>{policy.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="返品ポリシー"
                    value={returnProfile}
                    onChange={(event) => setReturnProfile(event.target.value)}
                    className="mt-1 w-full border rounded-lg px-3 py-3"
                  />
                )}
              </label>
            </div>
            {policyMode === 'ebay' && !loadingPolicies && ebayPolicies && (
              <p className="text-xs text-gray-500 mt-2">
                最終同期: {new Date(ebayPolicies.syncedAt).toLocaleString('ja-JP')}
              </p>
            )}
          </section>

          <section className="border rounded-lg px-4 py-3 text-sm">
            {loadingProducts ? (
              <p className="text-gray-500">出品データを確認しています...</p>
            ) : (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <p>対象商品: <strong>{products.length}件</strong></p>
                <p className={invalidProducts.length ? 'text-red-600' : 'text-green-600'}>
                  出品必須項目未設定: <strong>{invalidProducts.length}件</strong>
                </p>
              </div>
            )}
            {invalidProducts.length > 0 && (
              <p className="text-xs text-red-600 mt-2">
                商品編集でタイトル・eBay価格・画像・カテゴリを設定してください。
                （例: {invalidProducts.slice(0, 3).map(({ issues }) => issues.join('/')).join('、')}）
              </p>
            )}
            {sellerMismatch && (
              <p className="text-xs text-red-600 mt-2">抽出時に選択した出品セラーへ戻してください。</p>
            )}
            {!sellerReady && (
              <p className="text-xs text-red-600 mt-2">eBayセラーIDを入力してください。</p>
            )}
            {directInvalidProducts.some(({ issues }) => issues.includes('オークション形式')) && (
              <p className="text-xs text-amber-600 mt-2">
                ダイレクト出品は固定価格商品のみ対応しています。オークション商品はCSV出品を使用してください。
              </p>
            )}
          </section>

          {showDirectConfirmation && (
            <section className="border-2 border-red-300 bg-red-50 rounded-lg px-4 py-4 space-y-3">
              <h3 className="font-bold text-red-700">eBayへの実出品を確認</h3>
              <p className="text-sm text-gray-800">
                <strong>{sellerId}</strong> に <strong>{directTargetProducts.length}件</strong>を
                固定価格で公開します。eBayの出品手数料が発生する場合があります。
              </p>
              <dl className="text-xs text-gray-700 grid sm:grid-cols-3 gap-2">
                <div><dt className="text-gray-500">配送</dt><dd>{shippingProfile}</dd></div>
                <div><dt className="text-gray-500">支払</dt><dd>{paymentProfile}</dd></div>
                <div><dt className="text-gray-500">返品</dt><dd>{returnProfile}</dd></div>
              </dl>
              <label className="flex items-start gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={directConfirmed}
                  onChange={(event) => setDirectConfirmed(event.target.checked)}
                  disabled={directRunning}
                  className="mt-1"
                />
                内容を確認し、eBayへ実際に出品することに同意します
              </label>
              {directRunning && (
                <p className="text-sm text-blue-700">
                  出品中: {directProgress.completed} / {directProgress.total}件
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowDirectConfirmation(false)
                    setDirectConfirmed(false)
                  }}
                  disabled={directRunning}
                  className="border rounded-lg px-4 py-2 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={publishDirectly}
                  disabled={!directConfirmed || directRunning}
                  className="bg-red-600 text-white rounded-lg px-4 py-2 disabled:opacity-40"
                >
                  {directRunning
                    ? `eBayへ出品中（${directProgress.completed}/${directProgress.total}）`
                    : `eBayへ${directTargetProducts.length}件出品`}
                </button>
              </div>
            </section>
          )}

          {error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}
          {notice && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{notice}</p>}
        </div>

        <div className="border-t px-6 py-4 flex flex-wrap items-center justify-end gap-3">
          <button onClick={onClose} className="border border-red-400 text-red-600 rounded-lg px-6 py-2.5 hover:bg-red-50">
            閉じる
          </button>
          <div className="mr-auto text-xs text-gray-500">
            ダイレクト出品はeBay接続・ポリシー同期後に利用できます。
          </div>
          <button
            onClick={() => {
              setError('')
              setNotice('')
              setDirectConfirmed(false)
              setShowDirectConfirmation(true)
            }}
            disabled={!canDirectListing}
            className="border border-red-500 text-red-600 rounded-lg px-6 py-2.5 hover:bg-red-50 disabled:border-gray-300 disabled:text-gray-400 disabled:cursor-not-allowed"
          >
            ダイレクト出品
          </button>
          <button
            onClick={() => downloadCsv('listing')}
            disabled={!canDownloadListing}
            className="border border-green-500 text-green-600 rounded-lg px-6 py-2.5 hover:bg-green-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {downloading === 'listing' ? 'CSV作成中...' : 'CSV出品'}
          </button>
          <button
            onClick={() => downloadCsv('specifics')}
            disabled={!canDownloadSpecifics}
            className="border border-blue-500 text-blue-600 rounded-lg px-6 py-2.5 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {downloading === 'specifics' ? '45列CSV作成中...' : 'SPECIFICS-IN 45列CSV出力'}
          </button>
        </div>
      </div>
    </div>
  )
}
