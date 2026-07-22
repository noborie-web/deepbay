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

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------- テスト用製品ファクトリ ----------

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
    ebay_brand: null,
    ebay_price: null,
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
      const input = screen.getByPlaceholderText('未設定') as HTMLInputElement
      expect(input.value).toBe('')
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

  it('ebay_price が数値の商品は入力欄にその値が表示される（$0 にならない）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => {
      const input = screen.getByDisplayValue('30') as HTMLInputElement
      expect(input.value).toBe('30')
    })
  })
})

describe('ProductEditPanel: 価格入力バリデーション', () => {
  it('0を入力するとエラーが表示され、保存ボタンが無効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('30'))

    const priceInput = screen.getByDisplayValue('30')
    await act(async () => {
      await userEvent.clear(priceInput)
      await userEvent.type(priceInput, '0')
    })

    expect(screen.getByText(/0より大きい値を入力してください/)).toBeTruthy()
    expect(screen.getByText(/💾 編集保存/)).toBeDisabled()
  })

  it('負数を入力するとエラーが表示され、保存ボタンが無効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('30'))

    await act(async () => {
      await userEvent.clear(screen.getByDisplayValue('30'))
      await userEvent.type(screen.getByPlaceholderText('未設定'), '-5')
    })

    expect(screen.getByText(/0より大きい値を入力してください/)).toBeTruthy()
    expect(screen.getByText(/💾 編集保存/)).toBeDisabled()
  })

  it('エラーを修正すると保存ボタンが再び有効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: 30 })],
    })
    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('30'))

    // 0を入力 → エラー
    const priceInput = screen.getByDisplayValue('30')
    await act(async () => {
      await userEvent.clear(priceInput)
      await userEvent.type(screen.getByPlaceholderText('未設定'), '0')
    })
    expect(screen.getByText(/💾 編集保存/)).toBeDisabled()

    // 正の値に修正 → 有効
    await act(async () => {
      await userEvent.clear(screen.getByPlaceholderText('未設定'))
      await userEvent.type(screen.getByPlaceholderText('未設定'), '29.99')
    })
    await waitFor(() => {
      expect(screen.queryByText(/0より大きい値を入力してください/)).toBeNull()
      expect(screen.getByText(/💾 編集保存/)).not.toBeDisabled()
    })
  })
})

describe('ProductEditPanel: saveAll の動作', () => {
  it('通信エラー後でも saving 状態が解除される（finally ブロック）', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1')],
    })
    fetchMock.mockRejectedValueOnce(new Error('Network error'))

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getAllByDisplayValue(/eBay Title/))

    const titleInput = screen.getAllByDisplayValue(/eBay Title/)[0]
    await act(async () => {
      await userEvent.clear(titleInput)
      await userEvent.type(titleInput, 'New Title')
    })

    const saveBtn = screen.getByText(/💾 編集保存/)
    await act(async () => { await userEvent.click(saveBtn) })

    await waitFor(() => {
      expect(saveBtn).not.toBeDisabled()
    })
    expect(screen.getByText(/通信エラー/)).toBeTruthy()
  })

  it('部分失敗: p1の表示は更新値、p2の入力は編集値を保持、再保存はp2のみ送信', async () => {
    // 初回ロード
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        makeProduct('p1', { ebay_title: 'Old Title 1' }),
        makeProduct('p2', { ebay_title: 'Old Title 2' }),
      ],
    })
    // 部分失敗レスポンス
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        ok: false,
        succeeded: ['p1'],
        failed: [{ productId: 'p2', error: '権限がありません' }],
      }),
    })
    // p2 のみの再保存
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p2'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => expect(screen.getAllByDisplayValue(/Old Title/)).toHaveLength(2))

    const [input1, input2] = screen.getAllByDisplayValue(/Old Title/) as HTMLInputElement[]
    await act(async () => {
      await userEvent.clear(input1)
      await userEvent.type(input1, 'New Title 1')
      await userEvent.clear(input2)
      await userEvent.type(input2, 'New Title 2')
    })

    await act(async () => { await userEvent.click(screen.getByText(/💾 編集保存/)) })

    await waitFor(() => {
      // p1 は成功 → products 状態が更新された値を表示
      expect(screen.getByDisplayValue('New Title 1')).toBeTruthy()
      // p2 は失敗 → edit が保持されて編集値を表示
      expect(screen.getByDisplayValue('New Title 2')).toBeTruthy()
      // エラーメッセージ表示
      expect(screen.getByText(/1件の保存に失敗/)).toBeTruthy()
    })

    // 再保存ボタンは有効（p2 のeditsが残っている）
    const saveBtn = screen.getByText(/💾 編集保存/)
    expect(saveBtn).not.toBeDisabled()

    // 再保存
    await act(async () => { await userEvent.click(saveBtn) })

    await waitFor(() => {
      // 3回目のfetch呼び出し（0=load, 1=first save, 2=second save）
      const calls = fetchMock.mock.calls
      expect(calls).toHaveLength(3)
      const secondSaveBody = JSON.parse(calls[2][1].body as string)
      // p2 だけが送信される
      expect(secondSaveBody.updates).toHaveLength(1)
      expect(secondSaveBody.updates[0].productId).toBe('p2')
    })
  })
})

describe('ProductEditPanel: 編集タブの保存操作', () => {
  it('編集タブでも保存ボタンが表示され、編集後に有効になる', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_price: null })],
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '編集' }))
    })

    const saveBtn = screen.getByText(/💾 編集保存/)
    expect(saveBtn).toBeDisabled()

    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText('未設定'), '83')
    })

    expect(saveBtn).not.toBeDisabled()
  })
})

describe('ProductEditPanel: ブランド編集', () => {
  it('商品ごとのブランド変更を保存APIへ送る', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_brand: 'PILOT' })],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('PILOT'))
    const brandInput = screen.getByDisplayValue('PILOT')
    await act(async () => {
      await userEvent.clear(brandInput)
      await userEvent.type(brandInput, 'SAILOR')
      await userEvent.click(screen.getByText(/💾 編集保存/))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.updates).toEqual([{ productId: 'p1', ebay_brand: 'SAILOR' }])
  })

  it('ブランド入力を空にするとnullを保存する', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_brand: 'PILOT' })],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('PILOT'))
    await act(async () => {
      await userEvent.clear(screen.getByDisplayValue('PILOT'))
      await userEvent.click(screen.getByText(/💾 編集保存/))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.updates).toEqual([{ productId: 'p1', ebay_brand: null }])
  })

  it('一括編集で同じブランドを現在ページへ適用する', async () => {
    const { default: BrandEditModal } = await import('../components/extraction/BrandEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <BrandEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getBrand={() => ''}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText('例: PILOT'), '  PILOT  ')
      await userEvent.click(screen.getByRole('button', { name: /適用 \(1件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith('PILOT', 'page')
  })

  it('一括編集でブランドを全商品からクリアする', async () => {
    const { default: BrandEditModal } = await import('../components/extraction/BrandEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <BrandEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getBrand={() => 'PILOT'}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText('ブランドをクリア'))
      await userEvent.click(screen.getByLabelText('抽出商品すべて'))
      await userEvent.click(screen.getByRole('button', { name: /適用 \(2件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith(null, 'all')
  })
})

describe('ProductEditPanel: 商品詳細編集', () => {
  it('詳細編集モードで商品ごとの商品詳細を保存APIへ送る', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [makeProduct('p1', { ebay_description: 'Old description' })],
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }),
    })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)

    await waitFor(() => screen.getByDisplayValue('簡易編集モード'))
    await act(async () => {
      await userEvent.selectOptions(screen.getByDisplayValue('簡易編集モード'), '詳細編集モード')
    })
    const description = await screen.findByDisplayValue('Old description')
    await act(async () => {
      await userEvent.clear(description)
      await userEvent.type(description, 'New description')
      await userEvent.click(screen.getByText(/💾 編集保存/))
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body.updates).toEqual([{ productId: 'p1', ebay_description: 'New description' }])
  })

  it('一括編集で同じ商品詳細を現在ページへ適用する', async () => {
    const { default: DescriptionEditModal } = await import('../components/extraction/DescriptionEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <DescriptionEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getDescription={() => ''}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.type(screen.getByPlaceholderText('商品詳細を入力'), 'Description')
      await userEvent.click(screen.getByRole('button', { name: /適用 \(1件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'set', value: 'Description' }), 'page')
  })

  it('一括編集で全商品の商品詳細をクリアする', async () => {
    const { default: DescriptionEditModal } = await import('../components/extraction/DescriptionEditModal')
    const products = [makeProduct('p1'), makeProduct('p2')]
    const onApply = vi.fn()

    render(
      <DescriptionEditModal
        products={products}
        pagedIds={new Set(['p1'])}
        getDescription={() => 'Description'}
        onApply={onApply}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText('商品詳細をクリア'))
      await userEvent.click(screen.getByLabelText('抽出商品すべて'))
      await userEvent.click(screen.getByRole('button', { name: /適用 \(2件\)/ }))
    })

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'clear' }), 'all')
  })
})

describe('PriceEditModal: 仕入価格未設定の処理', () => {
  it('倍率モードで仕入価格未設定商品があれば適用ボタンが無効', async () => {
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const products = [makeProduct('p1', { purchase_price_jpy: null, original_price: null })]
    const pagedIds = new Set(['p1'])

    render(
      <PriceEditModal
        products={products}
        pagedIds={pagedIds}
        getPurchaseJpy={() => null}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText(/仕入 × 倍率/))
    })

    const rateInput = screen.getByPlaceholderText('例: 0.08')
    await act(async () => { await userEvent.type(rateInput, '0.1') })

    expect(screen.getByText(/仕入価格未設定/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /適用/ })).toBeDisabled()
  })

  it('固定価格モードは仕入価格不要で適用できる', async () => {
    const { default: PriceEditModal } = await import('../components/extraction/PriceEditModal')
    const products = [makeProduct('p1', { purchase_price_jpy: null, original_price: null })]
    const pagedIds = new Set(['p1'])

    render(
      <PriceEditModal
        products={products}
        pagedIds={pagedIds}
        getPurchaseJpy={() => null}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    )

    await act(async () => {
      await userEvent.click(screen.getByLabelText(/固定ドル価格/))
    })

    const priceInput = screen.getByPlaceholderText('例: 49.99')
    await act(async () => { await userEvent.type(priceInput, '29.99') })

    expect(screen.getByRole('button', { name: /適用/ })).not.toBeDisabled()
  })
})
