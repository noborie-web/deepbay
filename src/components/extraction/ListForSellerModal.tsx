'use client'

import { useEffect, useState } from 'react'

interface Seller {
  id: string
  seller_id: string
  display_name: string | null
  listing_site_ids: string[] | null
}

interface PolicyOption {
  id: string
  name: string
}

interface PolicySet {
  payment: PolicyOption[]
  return: PolicyOption[]
  fulfillment: PolicyOption[]
}

interface Props {
  // 出品元(specifics-inで仕上げたCSVの元になった抽出)
  extractionId: string
  extractionName: string | null
  currentSellerAccountId: string | null
  onClose: () => void
}

const SITE_LABELS: Record<string, string> = {
  US: 'アメリカ (US / USD)',
  UK: 'イギリス (UK / GBP)',
  AU: 'オーストラリア (AU / AUD)',
}

// ユーザー要望(2026-11-01): miyabi-24(US)と akebono-32(UK)に同じ商品を出す際、
// specifics-in での白抜き・目視削除・AI生成・コンプライアンスチェックを2回
// 繰り返している。アカウントで変わるのは透かしだけなので、仕上げたCSVの
// 「アカウントによって変わる列」だけを差し替えて、作り直しを無くす。
//
// 複製と変換を分けると「先に複製しておく」順番を意識させることになるので、
// 出品元の抽出から1回の操作で済むようにしている。
export default function ListForSellerModal({
  extractionId, extractionName, currentSellerAccountId, onClose,
}: Props) {
  const [sellers, setSellers] = useState<Seller[] | null>(null)
  const [selected, setSelected] = useState('')
  const [pickedSite, setPickedSite] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [payment, setPayment] = useState('')
  const [returnProfile, setReturnProfile] = useState('')
  const [shipping, setShipping] = useState('')
  // ユーザー要望(2026-11-01): ビジネスポリシーも自動で取り込んでほしい。
  // 手入力だと、そのサイトに存在しない名前を書いてもCSVを作れてしまい、
  // eBayへのアップロードで初めて失敗する。
  const [policies, setPolicies] = useState<PolicySet | null>(null)
  const [policyLoading, setPolicyLoading] = useState(false)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ converted: number; skipped: number; created: number; reused: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/seller-accounts')
      .then(res => res.json())
      .then((data: { sellers?: Seller[]; error?: string }) => {
        if (cancelled) return
        if (data.error) { setError(data.error); setSellers([]); return }
        // 抽出と同じセラーには出せないので候補から外す
        const list = (data.sellers ?? []).filter(s => s.id !== currentSellerAccountId)
        setSellers(list)
        if (list.length === 1) setSelected(list[0].id)
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [currentSellerAccountId])

  // ビジネスポリシーはそのセラーが出品するサイトぶんしか取れないので、
  // 選べるサイトもそのセラーの設定に合わせる(無いサイトを選ばせない)。
  const siteOptions = (sellers?.find(s => s.id === selected)?.listing_site_ids ?? [])
    .filter(key => SITE_LABELS[key])
  // 選択中のサイトがそのセラーに無ければ、先頭のサイトとして扱う
  const site = siteOptions.includes(pickedSite) ? pickedSite : (siteOptions[0] ?? '')

  function changeSite(next: string) {
    // ポリシー名はサイトごとに別物なので、前のサイトの選択は持ち越さない
    setPickedSite(next)
    setPayment('')
    setReturnProfile('')
    setShipping('')
  }

  // 出品先セラーとサイトが決まったら、そのサイトのポリシーを取り込む。
  // ビジネスポリシーはマーケットプレイスごとに別物なので、サイトで引き直す。
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!selected || !site) { setPolicies(null); return }
      setPolicyLoading(true)
      setPolicyError(null)
      setPolicies(null)
      try {
        const res = await fetch(
          `/api/ebay/policies?sellerAccountId=${encodeURIComponent(selected)}`,
          { cache: 'no-store' },
        )
        const data = await res.json() as { bySite?: Record<string, PolicySet>; error?: string }
        if (cancelled) return
        if (data.error) { setPolicyError(data.error); return }
        const forSite = data.bySite?.[site]
        if (!forSite) {
          setPolicyError(`${site} のポリシーを取得できませんでした。eBayの接続とサイト設定を確認してください。`)
          return
        }
        setPolicies(forSite)
        // 1つしか無い種類は選んでおく(選び間違えようがないため)
        if (forSite.payment.length === 1) setPayment(forSite.payment[0].name)
        if (forSite.return.length === 1) setReturnProfile(forSite.return[0].name)
        if (forSite.fulfillment.length === 1) setShipping(forSite.fulfillment[0].name)
      } catch (e: unknown) {
        if (!cancelled) setPolicyError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setPolicyLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [selected, site])

  const ready = Boolean(selected) && Boolean(site) && Boolean(file)
    && payment.trim() !== '' && returnProfile.trim() !== '' && shipping.trim() !== '' && !running

  async function run() {
    if (!ready || !file) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const csv = await file.text()
      const res = await fetch(`/api/extractions/${extractionId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellerAccountId: selected,
          csv,
          site,
          paymentProfile: payment.trim(),
          returnProfile: returnProfile.trim(),
          shippingProfile: shipping.trim(),
        }),
      })
      const data = await res.json() as {
        ok?: boolean; csv?: string; converted?: number; skipped?: string[]
        created?: number; reused?: number; error?: string
      }
      if (!res.ok || !data.ok || !data.csv) throw new Error(data.error ?? '変換できませんでした')

      const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name.replace(/\.csv$/i, '') + `_${site}.csv`
      link.click()
      URL.revokeObjectURL(url)

      setResult({
        converted: data.converted ?? 0,
        skipped: (data.skipped ?? []).length,
        created: data.created ?? 0,
        reused: data.reused ?? 0,
      })
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
          <h2 className="font-bold text-gray-900">別セラーへ出品用に変換</h2>
          {extractionName && <p className="mt-1 text-xs text-gray-500 truncate">出品元: {extractionName}</p>}
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 text-sm">
          <p className="text-gray-700">
            仕上げたCSVを読み込み、別セラー向けに CustomLabel・価格・通貨・サイト・
            ビジネスポリシーだけを差し替えます。タイトル・商品説明・Item Specifics・
            画像URLはそのまま残るので、AI生成とコンプライアンスチェックをやり直す
            必要はありません。
          </p>
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            仕入先が同じなので、1点物を両方に出すと同じ1個を2箇所で売ることになります。
            仕入先が売り切れれば両方とも自動で取り下げられますが、検知までの間に
            両方で売れる可能性があります。
          </div>

          <div>
            <label className="block text-gray-700 mb-1">出品先のセラー</label>
            {sellers === null ? (
              <p className="text-gray-500">読み込んでいます…</p>
            ) : sellers.length === 0 ? (
              <p className="text-gray-500">出せるセラーがありません。</p>
            ) : (
              <div className="space-y-1">
                {sellers.map(seller => (
                  <label key={seller.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio" name="target-seller" value={seller.id}
                      checked={selected === seller.id}
                      onChange={() => { setSelected(seller.id); changeSite('') }}
                    />
                    <span className="text-gray-900">{seller.display_name?.trim() || seller.seller_id}</span>
                    <span className="text-xs text-gray-500">
                      {(seller.listing_site_ids ?? []).join('/') || 'US'}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-gray-700 mb-1">仕上げたCSV</label>
            <input
              type="file" accept=".csv,text/csv"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null) }}
              className="w-full text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              specifics-in から出力した、この抽出のCSVを選んでください。
            </p>
          </div>

          <div>
            <label className="block text-gray-700 mb-1">出品先サイト</label>
            <select
              value={site} onChange={(e) => changeSite(e.target.value)}
              disabled={siteOptions.length === 0}
              className="w-full border rounded px-2 py-1.5 disabled:bg-gray-100"
            >
              {siteOptions.length === 0
                ? <option value="">出品先のセラーを選んでください</option>
                : siteOptions.map(key => <option key={key} value={key}>{SITE_LABELS[key]}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              価格は出品価格から、そのときの為替レートと価格調整で計算し直します。
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-gray-700">
              ビジネスポリシー
              <span className="ml-1 text-xs text-gray-500">（eBayから取り込んだ{site}のもの）</span>
            </p>
            {policyLoading && <p className="text-gray-500">eBayから取り込んでいます…</p>}
            {policyError && <p className="text-red-600">{policyError}</p>}
            {policies && (
              <>
                <PolicySelect label="支払い" options={policies.payment} value={payment} onChange={setPayment} />
                <PolicySelect label="返品" options={policies.return} value={returnProfile} onChange={setReturnProfile} />
                <PolicySelect label="配送" options={policies.fulfillment} value={shipping} onChange={setShipping} />
              </>
            )}
          </div>

          {result && (
            <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
              <p>{result.converted.toLocaleString()}件を変換してダウンロードしました。</p>
              <p className="mt-1 text-gray-600">
                商品: 新規 {result.created.toLocaleString()}件 / 既存を再利用 {result.reused.toLocaleString()}件
              </p>
              {result.skipped > 0 && (
                <p className="mt-1 text-amber-700">
                  {result.skipped.toLocaleString()}件はこの抽出の商品と対応しないため出力していません。
                  CSVがこの抽出のものか確認してください。
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
            onClick={run} disabled={!ready}
            className="rounded px-4 py-1.5 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300"
          >
            {running ? '変換しています…' : '変換してダウンロード'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PolicySelect({ label, options, value, onChange }: {
  label: string
  options: PolicyOption[]
  value: string
  onChange: (next: string) => void
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border rounded px-2 py-1.5"
      >
        <option value="">選択してください</option>
        {options.map(option => (
          <option key={option.id} value={option.name}>{option.name}</option>
        ))}
      </select>
      {options.length === 0 && (
        <span className="text-xs text-amber-700">このサイトに{label}ポリシーがありません。</span>
      )}
    </label>
  )
}
