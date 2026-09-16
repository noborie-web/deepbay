// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryProductsSection from '@/components/inventory/InventoryProductsSection'
import type { Product } from '@/types/database'

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}))

// InventoryProductsSectionはInventoryPanel(eBay商品一覧タブ等)を内部で
// 描画するため、その分のpropsも渡す。このテストファイルでは商品テーブル側
// の挙動のみを検証する。
const panelProps = {
  listings: [],
  listingCount: 0,
  hasToken: false,
  statusCounts: { total: 3, draft: 1, listed: 1, sold: 1, delisted: 0 },
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: 'https://jp.mercari.com/item/1',
    source_site: 'mercari',
    source_item_id: null,
    original_title: '元タイトル',
    original_price: 5000,
    original_description: '',
    original_images: [],
    original_condition: null,
    ebay_title: null,
    ebay_brand: null,
    ebay_price: 40,
    ebay_description: null,
    ebay_images: [],
    ebay_item_specifics: {},
    ebay_condition: null,
    ebay_category_id: null,
    listing_status: 'draft',
    ebay_item_id: null,
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    seller_url: null,
    raw_source_data: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: 5000,
    price_type: 'fixed',
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    ...overrides,
  }
}

// ユーザー要望: 集計カード(総商品数・下書き・出品中・売却済み)をクリック
// すると対象商品のみに絞り込め、総商品数・下書きは選択して一括削除できる
// ようにしてほしい。
describe('InventoryProductsSection: 集計カードの絞り込みと選択削除', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // 絞り込み時の商品取得API(/api/inventory/products)は既定で失敗させ、
    // 手元の商品で絞り込む従来の挙動を検証する。
    fetchMock = vi.fn(async (url: string) => (
      String(url).startsWith('/api/inventory/products') ? { ok: false } : undefined
    ))
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('カードをクリックすると、その条件の商品だけに絞り込まれる', async () => {
    const items = [
      makeProduct({ id: 'p1', listing_status: 'draft', original_title: '下書き商品' }),
      makeProduct({ id: 'p2', listing_status: 'listed', original_title: '出品中商品' }),
      makeProduct({ id: 'p3', listing_status: 'sold', original_title: '売却済み商品' }),
    ]
    render(<InventoryProductsSection items={items} {...panelProps} />)

    expect(screen.getByText('下書き商品')).toBeInTheDocument()
    expect(screen.getByText('出品中商品')).toBeInTheDocument()
    expect(screen.getByText('売却済み商品')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /下書き/ }))

    expect(screen.getByText('下書き商品')).toBeInTheDocument()
    expect(screen.queryByText('出品中商品')).not.toBeInTheDocument()
    expect(screen.queryByText('売却済み商品')).not.toBeInTheDocument()
  })

  it('総商品数・下書きの絞り込みでは選択チェックボックスと削除ボタンが表示される', async () => {
    const items = [makeProduct({ id: 'p1', listing_status: 'draft' })]
    render(<InventoryProductsSection items={items} {...panelProps} />)

    expect(screen.getByText(/このページの総商品数を全選択/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /下書き/ }))
    expect(screen.getByText(/このページの下書きを全選択/)).toBeInTheDocument()
  })

  it('出品中・売却済みの絞り込みでは選択チェックボックスが表示されない', async () => {
    const items = [makeProduct({ id: 'p1', listing_status: 'listed' })]
    render(<InventoryProductsSection items={items} {...panelProps} />)

    await userEvent.click(screen.getByRole('button', { name: /出品中/ }))
    expect(screen.queryByText(/を全選択/)).not.toBeInTheDocument()
  })

  it('商品を選択して削除すると、DELETE APIが呼ばれ一覧から消える', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const items = [makeProduct({ id: 'p1', extraction_id: 'ext-1', original_title: '削除対象商品' })]
    render(<InventoryProductsSection items={items} {...panelProps} />)

    const checkboxes = screen.getAllByRole('checkbox')
    // 先頭は「全選択」チェックボックス、2番目が商品行のチェックボックス
    await userEvent.click(checkboxes[1])
    await userEvent.click(screen.getByRole('button', { name: '選択した1件を削除' }))

    await waitFor(() => expect(screen.queryByText('削除対象商品')).not.toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/products/ext-1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'p1' }),
    })
  })

  it('出品済みで削除がブロックされた商品は一覧に残り、警告が表示される', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'blocked' }) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const items = [makeProduct({ id: 'p1', extraction_id: 'ext-1', original_title: 'ブロック対象商品' })]
    render(<InventoryProductsSection items={items} {...panelProps} />)

    const checkboxes = screen.getAllByRole('checkbox')
    await userEvent.click(checkboxes[1])
    await userEvent.click(screen.getByRole('button', { name: '選択した1件を削除' }))

    await waitFor(() => expect(alertSpy).toHaveBeenCalled())
    expect(screen.getByText('ブロック対象商品')).toBeInTheDocument()
  })

  it('全選択チェックボックスで表示中の全商品が選択される', async () => {
    const items = [
      makeProduct({ id: 'p1' }),
      makeProduct({ id: 'p2' }),
    ]
    render(<InventoryProductsSection items={items} {...panelProps} />)

    await userEvent.click(screen.getByLabelText(/このページの総商品数を全選択/))
    expect(screen.getByRole('button', { name: '選択した2件を削除' })).toBeInTheDocument()
  })
})

describe('集計カードの件数', () => {
  it('表示中の商品ではなくDBの件数(statusCounts)を表示する', () => {
    // 実データで確認した不具合: 表示用の直近100件だけを数えていたため
    // 総商品数が100で頭打ちになり、出品中も実際の件数と合わなかった。
    const items = [makeProduct({ id: 'p1', listing_status: 'draft' })]
    render(
      <InventoryProductsSection
        items={items}
        {...panelProps}
        statusCounts={{ total: 158, draft: 10, listed: 148, sold: 0, delisted: 3 }}
      />,
    )
    expect(screen.getByText('総商品数').nextElementSibling).toHaveTextContent('158')
    expect(screen.getByText('出品中').nextElementSibling).toHaveTextContent('148')
    // ユーザー要望: 取り下げたリストも集計カードで確認できる
    expect(screen.getByText('取下げ').nextElementSibling).toHaveTextContent('3')
  })
})

describe('絞り込み時の商品取得', () => {
  it('カードで絞り込むと、その状態の商品をサーバーから取得して表示する(直近100件より古い下書きも出る)', async () => {
    // 実データで確認した不具合: 下書き4件が100件より古かったため、
    // 「下書き 4」なのに一覧は「下書きの商品はありません」になっていた。
    const oldDraft = makeProduct({ id: 'old-draft', listing_status: 'draft', original_title: '古い下書き商品' })
    global.fetch = vi.fn(async (url: string) => {
      if (String(url) === '/api/inventory/products?status=draft') {
        return { ok: true, json: async () => ({ products: [oldDraft] }) }
      }
      return { ok: false }
    }) as unknown as typeof fetch
    const items = [makeProduct({ id: 'p1', listing_status: 'listed', original_title: '出品中商品' })]
    render(
      <InventoryProductsSection
        items={items}
        {...panelProps}
        statusCounts={{ total: 152, draft: 4, listed: 144, sold: 0, delisted: 4 }}
      />,
    )

    await userEvent.click(screen.getByText('下書き'))

    expect(await screen.findByText('古い下書き商品')).toBeInTheDocument()
    expect(screen.queryByText('出品中商品')).not.toBeInTheDocument()
  })
})
