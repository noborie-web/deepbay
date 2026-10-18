// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// ユーザー要望(2026-10-18): リールのカテゴリで抽出しても、スプールやハンドル
// などの部品が混ざる。1件ずつ目視で探すのではなく、キーワードで該当だけを
// 集めて、まとめて消せるようにする。

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }))
vi.mock('lucide-react', () => ({ Trash2: () => null, Link: () => null, ChevronUp: () => null, ChevronDown: () => null }))

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => { vi.restoreAllMocks() })

function makeProduct(id: string, originalTitle: string, ebayTitle: string) {
  return {
    id, user_id: 'user-1', extraction_id: 'ext-1',
    source_url: `https://example.com/${id}`, source_site: 'yahoo_auction', source_item_id: id,
    original_title: originalTitle, original_price: 3000, original_description: 'desc',
    original_images: ['a.jpg', 'b.jpg'], original_condition: null,
    ebay_title: ebayTitle, ebay_brand: 'Shimano', ebay_price: 50, ebay_description: 'desc',
    ebay_images: ['a.jpg', 'b.jpg'], ebay_item_specifics: {}, ebay_condition: '中古', ebay_category_id: null,
    listing_status: 'draft' as const, listed_at: null, sold_at: null,
    seller_rating_count: null, seller_url: null, raw_source_data: null,
    shipping_days: null, source_updated_at: null, purchase_price_jpy: 1000,
    price_type: 'fixed' as const,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
}

// 本番の実例: リールのカテゴリにスプール・パーツが混ざっていた
const products = [
  makeProduct('p1', '19ヴァンキッシュ C5000XG 純正スプール 美品', '19 Vanquish C5000XG Genuine Spool'),
  makeProduct('p2', '21ツインパワー SW 5000HG リール本体', '21 Twin Power SW 5000HG Reel'),
  makeProduct('p3', 'ダイワ 純正パーツ ハンドルノブ', 'Daiwa Genuine Parts Handle Knob'),
]

async function renderPanel() {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => products })
  const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
  render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
  await waitFor(() => screen.getByLabelText(/19ヴァンキッシュ.*を選択/))
}

describe('除外キーワードでの絞り込み', () => {
  it('日本語の元タイトルで該当件数を出し、絞り込める', async () => {
    await renderPanel()
    await userEvent.type(screen.getByLabelText('除外キーワード'), 'スプール')

    const button = await screen.findByRole('button', { name: /該当1件に絞る/ })
    await userEvent.click(button)

    await waitFor(() => expect(screen.queryByDisplayValue(/Twin Power/)).toBeNull())
    expect(screen.getByDisplayValue(/Vanquish/)).toBeTruthy()
  })

  // 入力が英語でも拾えるよう、翻訳後のeBayタイトルも見る
  it('英語のeBayタイトルでも拾う', async () => {
    await renderPanel()
    await userEvent.type(screen.getByLabelText('除外キーワード'), 'Knob')
    await userEvent.click(await screen.findByRole('button', { name: /該当1件に絞る/ }))

    await waitFor(() => expect(screen.getByDisplayValue(/Handle Knob/)).toBeTruthy())
    expect(screen.queryByDisplayValue(/Vanquish/)).toBeNull()
  })

  it('カンマ区切りで複数の単語を一度に指定できる', async () => {
    await renderPanel()
    await userEvent.type(screen.getByLabelText('除外キーワード'), 'スプール, パーツ')
    await userEvent.click(await screen.findByRole('button', { name: /該当2件に絞る/ }))

    await waitFor(() => expect(screen.queryByDisplayValue(/Twin Power/)).toBeNull())
    expect(screen.getByDisplayValue(/Vanquish/)).toBeTruthy()
    expect(screen.getByDisplayValue(/Handle Knob/)).toBeTruthy()
  })

  // 短すぎる単語の誤爆(146件中103件が消えかけた件)に気づけるようにする
  it('単語ごとの該当件数を出す', async () => {
    await renderPanel()
    await userEvent.type(screen.getByLabelText('除外キーワード'), 'スプール, パーツ')
    await waitFor(() => expect(screen.getByText(/スプール 1/)).toBeTruthy())
    expect(screen.getByText(/パーツ 1/)).toBeTruthy()
  })

  it('もう一度押すと絞り込みを解除する', async () => {
    await renderPanel()
    await userEvent.type(screen.getByLabelText('除外キーワード'), 'スプール')
    await userEvent.click(await screen.findByRole('button', { name: /該当1件に絞る/ }))
    await waitFor(() => expect(screen.queryByDisplayValue(/Twin Power/)).toBeNull())

    await userEvent.click(screen.getByRole('button', { name: /絞り込み中（解除）/ }))
    await waitFor(() => expect(screen.getByDisplayValue(/Twin Power/)).toBeTruthy())
  })
})
