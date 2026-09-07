// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryPanel from '@/components/inventory/InventoryPanel'
import type { InventoryActiveListing } from '@/types/database'

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}))

function makeListing(id: string, quantity: number): InventoryActiveListing {
  return {
    id,
    user_id: 'user-1',
    ebay_item_id: `ebay-${id}`,
    custom_label: null,
    title: `Listing ${id}`,
    current_price: 10,
    quantity,
    quantity_sold: 0,
    listing_status: 'Active',
    start_time: null,
    end_time: null,
    source_url: null,
    product_id: null,
    raw_data: null,
    fetched_at: '2026-08-23T00:00:00.000Z',
    supplier_checked_at: null,
    created_at: '2026-08-23T00:00:00.000Z',
    updated_at: '2026-08-23T00:00:00.000Z',
  }
}

// ユーザー要望: 在庫管理画面上部の集計カード(総商品数・下書き・出品中・
// 売却済み)をクリックすると、「eBay商品一覧」タブも同じ条件で絞り込める
// ようにしてほしい。
describe('InventoryPanel: statusFilterによるeBay商品一覧の絞り込み', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/inventory/listings?')) {
        return {
          ok: true,
          json: async () => ({ listings: [makeListing('1', 1)], total: 1, unmatchedTotal: 0, page: 1, totalPages: 1 }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('タブを開く時点でstatusFilterが"listed"なら、statusパラメータ付きでAPIを呼ぶ', async () => {
    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} statusFilter="listed" />)
    await userEvent.click(screen.getByRole('button', { name: 'eBay商品一覧' }))

    await screen.findByText('Listing 1')
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/inventory/listings?'))
    expect(String(call?.[0])).toContain('status=listed')
  })

  it('"draft"の場合はAPIを呼ばず、空の状態を表示する', async () => {
    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} statusFilter="draft" />)
    await userEvent.click(screen.getByRole('button', { name: 'eBay商品一覧' }))

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/inventory/listings?'))).toBe(false)
    expect(await screen.findByText(/下書き/)).toBeInTheDocument()
  })

  it('既にeBay商品一覧タブを開いている状態でstatusFilterが変わると、再取得される', async () => {
    const { rerender } = render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} statusFilter="total" />)
    await userEvent.click(screen.getByRole('button', { name: 'eBay商品一覧' }))
    await screen.findByText('Listing 1')
    fetchMock.mockClear()

    rerender(<InventoryPanel listings={[]} listingCount={0} hasToken={false} statusFilter="sold" />)

    await screen.findByText(/絞り込み中/)
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/inventory/listings?'))
    expect(String(call?.[0])).toContain('status=sold')
  })
})
