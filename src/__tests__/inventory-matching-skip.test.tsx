// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryPanel from '@/components/inventory/InventoryPanel'
import type { InventoryActiveListing } from '@/types/database'

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}))

function makeListing(id: string): InventoryActiveListing {
  return {
    id,
    user_id: 'user-1',
    ebay_item_id: `ebay-${id}`,
    custom_label: null,
    title: `Listing ${id}`,
    current_price: 10,
    quantity: 1,
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

function mockInventoryRequests(listings: InventoryActiveListing[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/inventory/listings?')) {
      return { ok: true, json: async () => ({ listings, total: listings.length, unmatchedTotal: listings.length, page: 1, totalPages: 1 }) }
    }
    if (url.startsWith('/api/inventory/matching?') && !init?.method) {
      return { ok: true, json: async () => ({ products: [] }) }
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function openBulkMatching(listings: InventoryActiveListing[]) {
  render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)
  await userEvent.click(screen.getByRole('button', { name: 'eBay商品一覧' }))
  await screen.findByText(listings[0].title)
  await userEvent.click(screen.getByRole('checkbox', { name: '未一致商品をこのページで全選択' }))
  await userEvent.click(screen.getByRole('button', { name: `選択した商品を順番に紐付け（${listings.length}件）` }))
}

describe('InventoryPanel matching skip', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the modal open and advances through consecutive unmatched listings', async () => {
    const listings = [makeListing('1'), makeListing('2'), makeListing('3')]
    const fetchMock = mockInventoryRequests(listings)
    await openBulkMatching(listings)

    expect(await screen.findByText('eBay商品ID: ebay-1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '候補なし・スキップ' }))
    expect(await screen.findByText('eBay商品ID: ebay-2')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'DeepBay商品を選択' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '候補なし・スキップ' }))
    expect(await screen.findByText('eBay商品ID: ebay-3')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('closes on the final skip, clears selection, and does not persist a match', async () => {
    const listings = [makeListing('last')]
    const fetchMock = mockInventoryRequests(listings)
    await openBulkMatching(listings)

    await screen.findByText('eBay商品ID: ebay-last')
    await userEvent.click(screen.getByRole('button', { name: '候補なし・スキップ' }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'DeepBay商品を選択' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '選択した商品を順番に紐付け（0件）' })).toBeDisabled()
    expect(screen.getByText('未一致')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
})
