// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// ユーザー要望(2026-10-18): 数百件を端から見るのは現実的でないので、
// 怪しい商品だけに絞って目視確認できるようにする。

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }))
vi.mock('lucide-react', () => ({ Trash2: () => null, Link: () => null, ChevronUp: () => null, ChevronDown: () => null }))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => { vi.restoreAllMocks() })

function makeProduct(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, user_id: 'user-1', extraction_id: 'ext-1',
    source_url: `https://example.com/${id}`, source_site: 'yahoo_auction', source_item_id: id,
    original_title: `Original ${id}`, original_price: 3000, original_description: 'desc',
    original_images: ['a.jpg', 'b.jpg'], original_condition: null,
    ebay_title: `Title ${id}`, ebay_brand: 'Shimano', ebay_price: 50, ebay_description: 'desc',
    ebay_images: ['a.jpg', 'b.jpg'], ebay_item_specifics: {}, ebay_condition: '中古', ebay_category_id: null,
    listing_status: 'draft' as const, listed_at: null, sold_at: null,
    seller_rating_count: null, seller_url: null, raw_source_data: null,
    shipping_days: null, source_updated_at: null, purchase_price_jpy: 1000,
    price_type: 'fixed' as const,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  }
}

async function renderPanel(products: Array<{ id: string }>) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => products })
  const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
  render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
  // 最初の商品が描画されるまで待つ(タイトルはテストごとに違う)
  await waitFor(() => screen.getByLabelText(`Original ${products[0].id}を選択`))
}

describe('商品編集の確認用の絞り込み', () => {
  it('条件ごとの件数を出し、押すとその商品だけに絞る', async () => {
    await renderPanel([
      makeProduct('p1'),
      makeProduct('p2', { ebay_price: null }),
      makeProduct('p3', { ebay_images: ['only.jpg'], original_images: ['only.jpg'] }),
    ])

    // 価格未設定は1件
    const priceButton = screen.getByRole('button', { name: /価格未設定/ })
    expect(priceButton).toHaveTextContent('1')

    await userEvent.click(priceButton)
    await waitFor(() => expect(screen.queryByDisplayValue('Title p1')).toBeNull())
    expect(screen.getByDisplayValue('Title p2')).toBeTruthy()
    expect(screen.queryByDisplayValue('Title p3')).toBeNull()
  })

  // 「怪しいものを集める」ための絞り込みなので、複数選んだらどれかに当てはまれば残す
  it('条件を複数選ぶと、どれかに当てはまるものを残す', async () => {
    await renderPanel([
      makeProduct('p1'),
      makeProduct('p2', { ebay_price: null }),
      makeProduct('p3', { ebay_images: ['only.jpg'], original_images: ['only.jpg'] }),
    ])
    await userEvent.click(screen.getByRole('button', { name: /価格未設定/ }))
    await userEvent.click(screen.getByRole('button', { name: /画像1枚以下/ }))

    await waitFor(() => expect(screen.getByDisplayValue('Title p2')).toBeTruthy())
    expect(screen.getByDisplayValue('Title p3')).toBeTruthy()
    expect(screen.queryByDisplayValue('Title p1')).toBeNull()
  })

  it('絞り込みを解除すると全件に戻る', async () => {
    await renderPanel([makeProduct('p1'), makeProduct('p2', { ebay_price: null })])
    await userEvent.click(screen.getByRole('button', { name: /価格未設定/ }))
    await waitFor(() => expect(screen.queryByDisplayValue('Title p1')).toBeNull())

    await userEvent.click(screen.getByRole('button', { name: '絞り込みを解除' }))
    await waitFor(() => expect(screen.getByDisplayValue('Title p1')).toBeTruthy())
  })

  // 重複は見比べて消すものを決めるので、隣り合わせに並べる
  it('タイトル重複で絞ると、同じタイトルが隣り合わせになる', async () => {
    await renderPanel([
      makeProduct('p1', { ebay_title: 'Reel Case' }),
      makeProduct('p2', { ebay_title: 'Rod' }),
      makeProduct('p3', { ebay_title: 'reel  case' }),
    ])
    await userEvent.click(screen.getByRole('button', { name: /タイトル重複/ }))

    await waitFor(() => expect(screen.queryByDisplayValue('Rod')).toBeNull())
    // 大小・空白の違いだけの2件が残り、隣り合って並ぶ
    expect(screen.getAllByDisplayValue(/reel\s+case/i)).toHaveLength(2)
    const selects = screen.getAllByLabelText(/を選択$/)
    expect(selects.map((el) => el.getAttribute('aria-label'))).toEqual(
      ['Original p1を選択', 'Original p3を選択'],
    )
  })

  it('該当が0件の条件は押せない', async () => {
    await renderPanel([makeProduct('p1')])
    expect(screen.getByRole('button', { name: /価格未設定/ })).toBeDisabled()
  })

  // 直した商品はすぐ対象から外れる(編集中の値で判定する)
  it('価格を入れると「価格未設定」の件数が減る', async () => {
    await renderPanel([makeProduct('p1', { ebay_price: null })])
    expect(screen.getByRole('button', { name: /価格未設定/ })).toHaveTextContent('1')

    const priceInput = screen.getByPlaceholderText('未設定')
    await userEvent.type(priceInput, '25')

    await waitFor(() => expect(screen.getByRole('button', { name: /価格未設定/ })).toHaveTextContent('0'))
  })
})
