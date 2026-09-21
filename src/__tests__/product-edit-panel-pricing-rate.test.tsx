// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

// 実データで確認した不具合: 一括価格編集(段階利益方式)で計算に使った為替
// レートが保存リクエストに含まれず、出品済み商品の pricing_jpy_per_usd が
// 常にnullだった(出品時の為替との差分検知ができない)。

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}))
vi.mock('lucide-react', () => ({
  Trash2: () => null, Link: () => null, ChevronUp: () => null, ChevronDown: () => null,
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null } })) } })),
}))
// 価格編集モーダルは、適用ボタンで「$120 / 為替156.84」を適用するスタブに置き換える
vi.mock('../components/extraction/PriceEditModal', () => ({
  default: ({ onApply, onClose }: { onApply: (g: () => number, s: 'all', r: number | null) => void; onClose: () => void }) => (
    <button onClick={() => { onApply(() => 120, 'all', 156.84); onClose() }}>スタブ適用</button>
  ),
}))

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => { vi.restoreAllMocks() })

function makeProduct(id: string) {
  return {
    id, user_id: 'user-1', extraction_id: 'ext-1', source_url: `https://example.com/${id}`, source_site: 'mercari',
    source_item_id: id, original_title: `Original ${id}`, original_price: 5000, original_description: null,
    original_images: [], original_condition: null, ebay_title: `eBay Title ${id}`, ebay_brand: null, ebay_price: null,
    ebay_description: null, ebay_images: [], ebay_item_specifics: {}, ebay_condition: '中古', ebay_category_id: null,
    listing_status: 'draft' as const, listed_at: null, sold_at: null, seller_rating_count: null, seller_url: null,
    raw_source_data: null, shipping_days: null, source_updated_at: null, purchase_price_jpy: 5000,
    price_type: 'fixed' as const, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
}

describe('ProductEditPanel: 一括価格編集の為替レート保存', () => {
  it('適用した価格と一緒に pricing_jpy_per_usd も保存APIへ送る', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [makeProduct('p1')] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, succeeded: ['p1'], failed: [] }) })

    const { default: ProductEditPanel } = await import('../components/extraction/ProductEditPanel')
    render(<ProductEditPanel extractionId="ext-1" onClose={() => {}} />)
    await waitFor(() => screen.getByDisplayValue('eBay Title p1'))

    await userEvent.click(screen.getByRole('button', { name: /^編集$/ }))
    // 「価格」行の編集ボタンでモーダルを開く
    const priceLabel = screen.getAllByText('価格').find((el) => el.tagName === 'SPAN')!
    await userEvent.click(within(priceLabel.parentElement as HTMLElement).getByRole('button', { name: '編集' }))
    await userEvent.click(await screen.findByRole('button', { name: 'スタブ適用' }))
    await userEvent.click(screen.getByRole('button', { name: /編集保存/ }))

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('/bulk'))
      expect(saveCall).toBeTruthy()
      const body = JSON.parse(saveCall![1].body as string)
      expect(body.updates[0]).toMatchObject({ productId: 'p1', ebay_price: 120, pricing_jpy_per_usd: 156.84 })
    })
  })
})
