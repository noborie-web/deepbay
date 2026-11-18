// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ListForSellerModal from '@/components/extraction/ListForSellerModal'

// 本番で確認した不具合(2026-11-18): 仕上げたCSVをAPIに送って変換させていたが、
// 商品説明のHTMLが入るCSVは数MBになる(USED-1118.csv は4.8MB)。Vercelは
// リクエスト本文を4.5MBで打ち切るので、画面には本文の
// "Request Entity Too Large" をJSONとして読もうとした
// 「Unexpected token 'R'」だけが出ていた。
// CSVは送らず、対応表だけを受け取ってこの画面で変換する。

const SELLERS = { sellers: [{ id: 'seller-akebono', seller_id: 'akebono-32', display_name: null, listing_site_ids: ['UK'] }] }
const POLICIES = {
  bySite: {
    UK: {
      payment: [{ id: 'p1', name: 'eBay Payments' }],
      return: [{ id: 'r1', name: 'UK Returns' }],
      fulfillment: [{ id: 'f1', name: 'UK Shipping' }],
    },
  },
}
const REPLACEMENTS = {
  ok: true, created: 1, reused: 0, site: 'UK', site_id: 'UK', currency: 'GBP',
  replacements: [{ from: 'kakehashi_old_1', customLabel: 'kakehashi_new_1', startPrice: 311.5 }],
}

const HEADER = '"Action(CC=Cp1252)","CustomLabel","StartPrice","Title","Description","Currency","SiteID","PaymentProfileName","ReturnProfileName","ShippingProfileName"'
const CSV = HEADER + '\r\n'
  + '"Add","kakehashi_old_1","404.97","Rare N64","<div>説明, です</div>","USD","US","eBay Payments","US Returns","US Shipping"\r\n'

afterEach(() => { vi.restoreAllMocks() })

describe('別セラーへ出品用に変換(画面)', () => {
  it('CSVはサーバーに送らず、受け取った対応表で変換してダウンロードする', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init
      if (String(url).includes('/api/seller-accounts')) return new Response(JSON.stringify(SELLERS))
      if (String(url).includes('/api/ebay/policies')) return new Response(JSON.stringify(POLICIES))
      return new Response(JSON.stringify(REPLACEMENTS))
    })
    vi.stubGlobal('fetch', fetchMock)

    let saved: Blob | null = null
    URL.createObjectURL = ((blob: Blob) => { saved = blob; return 'blob:x' }) as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<ListForSellerModal
      extractionId="ext-1" extractionName="Rare Nintendo"
      currentSellerAccountId="seller-miyabi" onClose={() => {}}
    />)

    const user = userEvent.setup()
    await screen.findByText('akebono-32')
    await waitFor(() => expect(screen.getByDisplayValue('eBay Payments')).toBeInTheDocument())

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, new File([CSV], 'USED-1118.csv', { type: 'text/csv' }))
    await user.click(screen.getByRole('button', { name: '変換してダウンロード' }))

    await waitFor(() => expect(screen.getByText(/件を変換してダウンロードしました/)).toBeInTheDocument())

    // 変換APIにCSVを載せない(本文の上限に掛かるため)
    const convertCall = fetchMock.mock.calls.find(args => String(args[0]).includes('/duplicate'))
    const body = JSON.parse(String((convertCall?.[1] as RequestInit | undefined)?.body))
    expect(body).toEqual({ sellerAccountId: 'seller-akebono', site: 'UK' })

    // 変換そのものはこの画面で行う
    const downloadedText = await (saved as unknown as Blob).text()
    expect(downloadedText).toContain('"kakehashi_new_1"')
    expect(downloadedText).toContain('"311.50"')
    expect(downloadedText).toContain('"GBP"')
    expect(downloadedText).toContain('"UK Shipping"')
    // AI生成の結果はそのまま残す
    expect(downloadedText).toContain('<div>説明, です</div>')

    clickSpy.mockRestore()
  })
})
