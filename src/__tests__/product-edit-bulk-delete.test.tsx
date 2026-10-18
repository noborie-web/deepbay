// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// ユーザー要望(2026-10-18): 不要な商品をレ点で選んで、まとめて削除したい。
// 1件ずつの削除と同じく、実際のDELETEは「編集保存」まで保留する。

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }))
vi.mock('lucide-react', () => ({ Trash2: () => null, Link: () => null, ChevronUp: () => null, ChevronDown: () => null }))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  global.fetch = fetchMock as unknown as typeof fetch
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('alert', vi.fn())
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function makeProduct(id: string) {
  return {
    id, user_id: 'user-1', extraction_id: 'ext-1',
    source_url: `https://example.com/${id}`, source_site: 'yahoo_auction', source_item_id: id,
    original_title: `Original ${id}`, original_price: 3000, original_description: null,
    original_images: [], original_condition: null,
    ebay_title: `eBay Title ${id}`, ebay_brand: null, ebay_price: null, ebay_description: null,
    ebay_images: [], ebay_item_specifics: {}, ebay_condition: '中古', ebay_category_id: null,
    listing_status: 'draft' as const, listed_at: null, sold_at: null,
    seller_rating_count: null, seller_url: null, raw_source_data: null,
    shipping_days: null, source_updated_at: null, purchase_price_jpy: null,
    price_type: 'fixed' as const,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
}

async function renderPanel() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => [makeProduct('p1'), makeProduct('p2'), makeProduct('p3')],
  })
  const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
  render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
  await waitFor(() => screen.getByDisplayValue('eBay Title p1'))
}

describe('商品編集パネルの一括削除', () => {
  it('レ点で選んだ商品をまとめて除外予定にする', async () => {
    await renderPanel()
    await userEvent.click(screen.getByLabelText('Original p1を選択'))
    await userEvent.click(screen.getByLabelText('Original p3を選択'))
    expect(screen.getByText(/選択 2件/)).toBeTruthy()

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await userEvent.click(screen.getByRole('button', { name: /選択した2件を削除/ }))

    await waitFor(() => expect(screen.queryByDisplayValue('eBay Title p1')).toBeNull())
    // 出品済みかどうかの判定は、選択分をまとめて1回で投げる
    const checkCall = fetchMock.mock.calls.find(([url]) => String(url).includes('check=true'))
    expect(checkCall).toBeTruthy()
    expect(JSON.parse(String(checkCall![1].body))).toEqual({ productIds: ['p1', 'p3'] })
    // 残った商品はそのまま。削除は「編集保存」まで確定しない
    expect(screen.getByDisplayValue('eBay Title p2')).toBeTruthy()
    expect(screen.getByText(/保存待ちの除外: 2件/)).toBeTruthy()
  })

  it('Shift+クリックで範囲をまとめて選べる', async () => {
    await renderPanel()
    await userEvent.click(screen.getByLabelText('Original p1を選択'))
    fireEvent.click(screen.getByLabelText('Original p3を選択'), { shiftKey: true })
    // p1〜p3 がまとめて選ばれる
    await waitFor(() => expect(screen.getByText(/選択 3件/)).toBeTruthy())
  })

  it('全選択と解除ができる', async () => {
    await renderPanel()
    const selectAll = screen.getByLabelText('このページの商品をすべて選択')
    await userEvent.click(selectAll)
    expect(screen.getByText(/選択 3件/)).toBeTruthy()
    await userEvent.click(selectAll)
    expect(screen.getByText(/選択 0件/)).toBeTruthy()
  })

  it('何も選んでいなければ削除ボタンは押せない', async () => {
    await renderPanel()
    expect(screen.getByRole('button', { name: /選択した0件を削除/ })).toBeDisabled()
  })

  // 出品済みを消すとeBayとの照合ができなくなるため、承諾したときだけ進める
  it('出品済みが含まれる場合は警告し、断れば消さない', async () => {
    await renderPanel()
    await userEvent.click(screen.getByLabelText('Original p1を選択'))

    fetchMock.mockResolvedValueOnce({
      ok: false, status: 409,
      json: async () => ({ error: '出品済みの商品です。', blockedProducts: [{ id: 'p1', title: 'Original p1' }] }),
    })
    const confirmMock = vi.fn()
      .mockReturnValueOnce(true)   // 「削除しますか？」
      .mockReturnValueOnce(false)  // 「出品済みです。それでも進めますか？」
    vi.stubGlobal('confirm', confirmMock)

    await userEvent.click(screen.getByRole('button', { name: /選択した1件を削除/ }))

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2))
    expect(screen.getByDisplayValue('eBay Title p1')).toBeTruthy()
    expect(screen.queryByText(/保存待ちの除外/)).toBeNull()
  })
})
