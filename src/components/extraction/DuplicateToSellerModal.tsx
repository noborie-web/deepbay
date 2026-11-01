'use client'

import { useEffect, useState } from 'react'

interface Seller {
  id: string
  seller_id: string
  display_name: string | null
  listing_site_ids: string[] | null
}

interface Props {
  extractionId: string
  extractionName: string | null
  currentSellerAccountId: string | null
  onClose: () => void
  onDuplicated: () => void
}

// ユーザー要望(2026-11-01): miyabi-24(US)に出した商品を akebono-32(UK)にも出して
// 時間を短縮したい。出来上がったCSVを手で書き換えると、為替レートと価格調整が
// その時点の値で固定され、ポリシー名も手入力になる。商品を別セラーの抽出として
// 複製すれば、既存のCSV出力(sites=UK)がそのまま使える。
export default function DuplicateToSellerModal({
  extractionId, extractionName, currentSellerAccountId, onClose, onDuplicated,
}: Props) {
  const [sellers, setSellers] = useState<Seller[] | null>(null)
  const [selected, setSelected] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/seller-accounts')
      .then(res => res.json())
      .then((data: { sellers?: Seller[]; error?: string }) => {
        if (cancelled) return
        if (data.error) { setError(data.error); setSellers([]); return }
        // 複製元と同じセラーには出せないので候補から外す
        setSellers((data.sellers ?? []).filter(s => s.id !== currentSellerAccountId))
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [currentSellerAccountId])

  async function duplicate() {
    if (!selected || running) return
    setRunning(true)
    setError(null)
    try {
      const res = await fetch(`/api/extractions/${extractionId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerAccountId: selected }),
      })
      const data = await res.json() as { ok?: boolean; products?: number; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? '複製できませんでした')
      onDuplicated()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b">
          <h2 className="font-bold text-gray-900">別セラーへ複製</h2>
          {extractionName && <p className="mt-1 text-xs text-gray-500 truncate">{extractionName}</p>}
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-sm">
          <p className="text-gray-700">
            同じ商品を別の出品セラー用に複製します。商品IDが新しくなるので
            CustomLabel も別になり、出品ごとに在庫管理が効きます。
            価格・通貨・ビジネスポリシーは、複製後のCSV出力でそのセラーの設定が入ります。
          </p>
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            仕入先が同じなので、1点物を両方に出すと同じ1個を2箇所で売ることになります。
            仕入先が売り切れれば両方とも自動で取り下げられますが、検知までの間に
            両方で売れる可能性があります。
          </div>
          {sellers === null ? (
            <p className="text-gray-500">出品セラーを読み込んでいます…</p>
          ) : sellers.length === 0 ? (
            <p className="text-gray-500">複製できる出品セラーがありません。</p>
          ) : (
            <div className="space-y-2">
              {sellers.map(seller => (
                <label key={seller.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="duplicate-seller"
                    value={seller.id}
                    checked={selected === seller.id}
                    onChange={() => setSelected(seller.id)}
                  />
                  <span className="text-gray-900">{seller.display_name?.trim() || seller.seller_id}</span>
                  <span className="text-xs text-gray-500">
                    {(seller.listing_site_ids ?? []).join('/') || 'US'}
                  </span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="text-red-600">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="border rounded px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            キャンセル
          </button>
          <button
            onClick={duplicate}
            disabled={!selected || running}
            className="rounded px-4 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300"
          >
            {running ? '複製しています…' : '複製する'}
          </button>
        </div>
      </div>
    </div>
  )
}
