// @vitest-environment jsdom
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import InventoryPanel from '@/components/inventory/InventoryPanel'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))

// ユーザー報告(2026-10-11): 626件あるはずの「取り下げCSVを出力」ボタンが
// 見つからない。件数を表示中のページ内だけから数えていたため、そのページに
// 該当行が無いと警告ごと出なかった。全ページ合計(unmatchedTotal)を使う。
function listing(id: string, productId: string | null) {
  return {
    id, ebay_item_id: id, custom_label: `kakehashi_${id}`, title: `Item ${id}`,
    current_price: 10, quantity: 1, quantity_sold: 0, listing_status: 'Active',
    product_id: productId, site_id: 'US', currency: 'USD',
    start_time: null, end_time: null, supplier_diff: null,
  }
}

function mockListingsResponse(listings: unknown[], unmatchedTotal: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/inventory/listings')) {
      return {
        ok: true,
        json: async () => ({ listings, total: listings.length, unmatchedTotal, page: 1, pageSize: 50, totalPages: 1 }),
      }
    }
    return { ok: true, json: async () => ({}) }
  }))
}

describe('商品データなしの警告', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('表示中のページに該当行が無くても、全体の件数で警告とボタンを出す', async () => {
    // このページは全件が紐付き済み。だが全体では626件が未紐付け。
    mockListingsResponse([listing('1', 'p1'), listing('2', 'p2')], 626)

    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'eBay商品一覧' }))

    expect(await screen.findByText(/商品データが失われている出品が626件あります/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /この626件の取り下げCSVを出力/ })).toBeInTheDocument()
  })

  it('全体で0件なら警告を出さない', async () => {
    mockListingsResponse([listing('1', 'p1')], 0)

    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'eBay商品一覧' }))

    expect(await screen.findByText('Item 1')).toBeInTheDocument()
    expect(screen.queryByText(/商品データが失われている出品/)).not.toBeInTheDocument()
  })
})
