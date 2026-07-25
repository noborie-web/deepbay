'use client'

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { getListingIssues } from '@/lib/listing-export'
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
  const [sellerAccountId, setSellerAccountId] = useState(initialSellerId)
  const [shippingProfile, setShippingProfile] = useState(DEFAULT_POLICIES.shipping)
  const [paymentProfile, setPaymentProfile] = useState(DEFAULT_POLICIES.payment)
  const [returnProfile, setReturnProfile] = useState(DEFAULT_POLICIES.returns)
  const [products, setProducts] = useState<Product[]>([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [downloading, setDownloading] = useState<'listing' | 'specifics' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

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
  const sellerMismatch = Boolean(
    extraction.seller_account_id && sellerAccountId !== extraction.seller_account_id,
  )
  const policiesReady = Boolean(
    shippingProfile.trim() && paymentProfile.trim() && returnProfile.trim(),
  )
  const canDownloadListing = !loadingProducts
    && products.length > 0
    && invalidProducts.length === 0
    && !sellerMismatch
    && policiesReady
    && !downloading
  const canDownloadSpecifics = !loadingProducts
    && products.length > 0
    && !sellerMismatch
    && !downloading

  async function downloadCsv(kind: 'listing' | 'specifics') {
    setError('')
    setNotice('')
    setDownloading(kind)
    try {
      const params = new URLSearchParams({
        extractionId: extraction.id,
        sellerAccountId,
      })
      if (kind === 'listing') {
        params.set('shippingProfile', shippingProfile.trim())
        params.set('paymentProfile', paymentProfile.trim())
        params.set('returnProfile', returnProfile.trim())
      }
      const path = kind === 'listing' ? '/api/csv' : '/api/csv/specifics'
      const response = await fetch(`${path}?${params.toString()}`)
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error ?? 'CSV出力に失敗しました')
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
        : 'Specifics用CSVを出力しました。')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV出力に失敗しました')
    } finally {
      setDownloading(null)
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

          <label className="block">
            <span className="text-sm text-gray-500">出品セラー</span>
            <select
              aria-label="出品セラー"
              value={sellerAccountId}
              onChange={(event) => setSellerAccountId(event.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-3"
            >
              {sellers.map((seller) => (
                <option key={seller.id} value={seller.id}>
                  {seller.display_name || seller.seller_id}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm text-gray-500">出品ポリシー選択方法</span>
            <select aria-label="出品ポリシー選択方法" value="manual" disabled className="mt-1 w-full border rounded-lg px-3 py-3 bg-gray-50">
              <option value="manual">手動設定</option>
            </select>
          </label>

          <section>
            <h3 className="text-lg font-bold mb-3">出品ポリシー選択</h3>
            <div className="grid md:grid-cols-3 gap-4">
              <label>
                <span className="text-sm text-gray-500">配送ポリシー</span>
                <input
                  aria-label="配送ポリシー"
                  value={shippingProfile}
                  onChange={(event) => setShippingProfile(event.target.value)}
                  className="mt-1 w-full border rounded-lg px-3 py-3"
                />
              </label>
              <label>
                <span className="text-sm text-gray-500">支払ポリシー</span>
                <input
                  aria-label="支払ポリシー"
                  value={paymentProfile}
                  onChange={(event) => setPaymentProfile(event.target.value)}
                  className="mt-1 w-full border rounded-lg px-3 py-3"
                />
              </label>
              <label>
                <span className="text-sm text-gray-500">返品ポリシー</span>
                <input
                  aria-label="返品ポリシー"
                  value={returnProfile}
                  onChange={(event) => setReturnProfile(event.target.value)}
                  className="mt-1 w-full border rounded-lg px-3 py-3"
                />
              </label>
            </div>
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
          </section>

          {error && <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}
          {notice && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">{notice}</p>}
        </div>

        <div className="border-t px-6 py-4 flex flex-wrap items-center justify-end gap-3">
          <button onClick={onClose} className="border border-red-400 text-red-600 rounded-lg px-6 py-2.5 hover:bg-red-50">
            閉じる
          </button>
          <div className="mr-auto text-xs text-gray-500">
            ダイレクト出品はeBay OAuth接続後に利用できます。
          </div>
          <button disabled className="border border-gray-300 text-gray-400 rounded-lg px-6 py-2.5 cursor-not-allowed">
            ダイレクト出品（準備中）
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
            {downloading === 'specifics' ? 'CSV作成中...' : 'SPECIFICS用CSV出力'}
          </button>
        </div>
      </div>
    </div>
  )
}
