'use client'

import { useState } from 'react'

interface Props {
  // 変換先(複製した側)の抽出
  extractionId: string
  extractionName: string | null
  defaultSite: string
  onClose: () => void
}

const SITES = [
  { key: 'UK', label: 'イギリス (UK / GBP)' },
  { key: 'AU', label: 'オーストラリア (AU / AUD)' },
  { key: 'US', label: 'アメリカ (US / USD)' },
]

// ユーザー要望(2026-11-01): miyabi-24(US)と akebono-32(UK)に同じ商品を出す際、
// specifics-in での白抜き・目視削除・AI生成・コンプライアンスチェックを2回
// 繰り返している。アカウントで変わるのは透かしだけなので、完成したCSVの
// 「アカウントによって変わる列」だけを差し替えて、作り直しを無くす。
export default function ConvertListingCsvModal({
  extractionId, extractionName, defaultSite, onClose,
}: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [site, setSite] = useState(defaultSite)
  const [payment, setPayment] = useState('')
  const [returnProfile, setReturnProfile] = useState('')
  const [shipping, setShipping] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ converted: number; skipped: string[] } | null>(null)

  const ready = file && payment.trim() && returnProfile.trim() && shipping.trim() && !running

  async function convert() {
    if (!ready || !file) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const csv = await file.text()
      const res = await fetch('/api/csv/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv,
          targetExtractionId: extractionId,
          site,
          paymentProfile: payment.trim(),
          returnProfile: returnProfile.trim(),
          shippingProfile: shipping.trim(),
        }),
      })
      const data = await res.json() as {
        ok?: boolean; csv?: string; converted?: number; skipped?: string[]; error?: string
      }
      if (!res.ok || !data.ok || !data.csv) throw new Error(data.error ?? '変換できませんでした')

      const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name.replace(/\.csv$/i, '') + `_${site}.csv`
      link.click()
      URL.revokeObjectURL(url)

      setResult({ converted: data.converted ?? 0, skipped: data.skipped ?? [] })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b">
          <h2 className="font-bold text-gray-900">完成CSVを変換</h2>
          {extractionName && <p className="mt-1 text-xs text-gray-500 truncate">変換先: {extractionName}</p>}
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-sm">
          <p className="text-gray-700">
            specifics-in で仕上げたCSVを読み込み、この抽出のセラー向けに
            CustomLabel・価格・通貨・サイト・ビジネスポリシーだけを差し替えます。
            タイトル・商品説明・Item Specifics・画像URLはそのまま残るので、
            AI生成とコンプライアンスチェックをやり直す必要はありません。
          </p>

          <div>
            <label className="block text-gray-700 mb-1">完成CSV</label>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null) }}
              className="w-full text-sm"
            />
          </div>

          <div>
            <label className="block text-gray-700 mb-1">出品先サイト</label>
            <select
              value={site}
              onChange={(e) => setSite(e.target.value)}
              className="w-full border rounded px-2 py-1.5"
            >
              {SITES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              価格は出品価格から、そのときの為替レートと価格調整で計算し直します。
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-gray-700">
              ビジネスポリシー
              <span className="ml-1 text-xs text-gray-500">（そのサイトに存在する名前を入れてください）</span>
            </p>
            <input
              value={payment} onChange={(e) => setPayment(e.target.value)}
              placeholder="支払いポリシー名" className="w-full border rounded px-2 py-1.5"
            />
            <input
              value={returnProfile} onChange={(e) => setReturnProfile(e.target.value)}
              placeholder="返品ポリシー名" className="w-full border rounded px-2 py-1.5"
            />
            <input
              value={shipping} onChange={(e) => setShipping(e.target.value)}
              placeholder="配送ポリシー名" className="w-full border rounded px-2 py-1.5"
            />
          </div>

          {result && (
            <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
              {result.converted.toLocaleString()}件を変換してダウンロードしました。
              {result.skipped.length > 0 && (
                <p className="mt-1 text-amber-700">
                  {result.skipped.length.toLocaleString()}件は複製先に対応する商品が無いため出力していません。
                  先に「別セラーへ複製」を実行してください。
                </p>
              )}
            </div>
          )}
          {error && <p className="text-red-600">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="border rounded px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
            とじる
          </button>
          <button
            onClick={convert}
            disabled={!ready}
            className="rounded px-4 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300"
          >
            {running ? '変換しています…' : '変換してダウンロード'}
          </button>
        </div>
      </div>
    </div>
  )
}
