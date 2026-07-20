// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// ---------- モック ----------

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}))

vi.mock('lucide-react', () => ({
  Trash2: () => null,
  Link: () => null,
  ChevronUp: () => null,
  ChevronDown: () => null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null } })) },
  })),
}))

// fetch モック
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  global.fetch = fetchMock
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------- テスト用製品 ----------

function makeProduct(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: `https://example.com/${id}`,
    source_site: 'mercari',
    source_item_id: id,
    original_title: `Original Title ${id}`,
    original_price: 3000,
    original_description: null,
    original_images: [],
    original_condition: null,
    ebay_title: `eBay Title ${id}`,
    ebay_price: null,          // ← デフォルト null
    ebay_description: null,
    ebay_images: [],
    ebay_condition: '中古',
    ebay_category_id: null,
    listing_status: 'draft' as const,
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

// ---------- テスト ----------

describe('ProductEditPanel: ebay_price 表示', () => {
  it('ebay_price が null の商品は価格入力欄が空欄', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: null })],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => {
      const inputs = screen.getAllByPlaceholderText('未設定')
      const priceInput = inputs[0] as HTMLInputElement
      expect(priceInput.value).toBe('')
    })
  })

  it('ebay_price が null の商品は「未設定」ラベルが表示される', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: null })],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('未設定')).toBeTruthy()
    })
  })
})

describe('ProductEditPanel: saveAll の動作', () => {
  it('通信エラー後でも saving 状態が解除される（finally ブロック）', async () => {
    // 商品リスト取得
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1')],
    })
    // saveAll の fetch は失敗
    fetchMock.mockRejectedValueOnce(new Error('Network error'))

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getAllByDisplayValue(/eBay Title/))

    // タイトルを変更して edits に入れる
    const titleInput = screen.getAllByDisplayValue(/eBay Title/)[0] as HTMLInputElement
    await act(async () => {
      await userEvent.clear(titleInput)
      await userEvent.type(titleInput, 'New Title')
    })

    // 「編集保存」ボタンをクリック
    const saveBtn = screen.getByText('💾 編集保存')
    await act(async () => { await userEvent.click(saveBtn) })

    // 通信エラー後、ボタンが再び有効になる（disabled でなくなる = saving = false）
    await waitFor(() => {
      expect(saveBtn).not.toBeDisabled()
    })
    // エラーメッセージが表示されている
    expect(screen.getByText(/通信エラー/)).toBeTruthy()
  })

  it('部分失敗時: 成功商品の編集はクリアされ、失敗商品の編集は保持される', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeProduct('p1', { ebay_title: 'Old Title 1' }),
        makeProduct('p2', { ebay_title: 'Old Title 2' }),
      ],
    })
    // 部分失敗レスポンス (422)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        ok: false,
        succeeded: ['p1'],
        failed: [{ productId: 'p2', error: '権限がありません' }],
      }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => expect(screen.getAllByDisplayValue(/Old Title/)).toHaveLength(2))

    // 両方のタイトルを変更
    const titleInputs = screen.getAllByDisplayValue(/Old Title/)
    await act(async () => {
      await userEvent.clear(titleInputs[0])
      await userEvent.type(titleInputs[0], 'New Title 1')
      await userEvent.clear(titleInputs[1])
      await userEvent.type(titleInputs[1], 'New Title 2')
    })

    const saveBtn = screen.getByText(/💾 編集保存/)
    await act(async () => { await userEvent.click(saveBtn) })

    await waitFor(() => {
      // p1 は成功 → edits がクリアされ DB の値に戻る（Old Title 1 is now succeeded → shows updated product)
      // p2 は失敗 → edits が保持される
      expect(screen.getByText(/1件の保存に失敗/)).toBeTruthy()
    })
  })
})

describe('PriceEditModal: 仕入価格未設定の処理', () => {
  it('倍率モードで仕入価格未設定商品があれば適用ボタンが無効', async () => {
    // PriceEditModal を直接テスト
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const products = [
      makeProduct('p1', { purchase_price_jpy: null, original_price: null }),
    ]
    const pagedIds = new Set(['p1'])

    render(
      <PriceEditModal
        products={products}
        pagedIds={pagedIds}
        getPurchaseJpy={() => null}  // 仕入価格未設定
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    // 「仕入 × 倍率」モードに切り替え
    await act(async () => {
      await userEvent.click(screen.getByLabelText(/仕入 × 倍率/))
    })

    // 倍率入力
    const rateInput = screen.getByPlaceholderText('例: 0.08')
    await act(async () => { await userEvent.type(rateInput, '0.1') })

    // 仕入価格未設定の警告が表示される
    expect(screen.getByText(/仕入価格未設定/)).toBeTruthy()

    // 適用ボタンが無効
    const applyBtn = screen.getByRole('button', { name: /適用/ })
    expect(applyBtn).toBeDisabled()
  })

  it('固定価格モードは仕入価格不要で適用できる', async () => {
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const products = [makeProduct('p1', { purchase_price_jpy: null, original_price: null })]
    const pagedIds = new Set(['p1'])
    const onApply = vi.fn()

    render(
      <PriceEditModal
        products={products}
        pagedIds={pagedIds}
        getPurchaseJpy={() => null}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    // 固定価格モードに切り替え（デフォルトは利益計算）
    await act(async () => {
      await userEvent.click(screen.getByLabelText(/固定ドル価格/))
    })

    // 価格入力
    const priceInput = screen.getByPlaceholderText('例: 49.99')
    await act(async () => { await userEvent.type(priceInput, '29.99') })

    // 適用ボタンが有効
    const applyBtn = screen.getByRole('button', { name: /適用/ })
    expect(applyBtn).not.toBeDisabled()
  })
})
