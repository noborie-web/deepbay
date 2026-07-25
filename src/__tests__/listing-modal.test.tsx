// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import ListingModal from '@/components/extraction/ListingModal'
import type { Extraction, Product, SellerAccount } from '@/types/database'

vi.mock('lucide-react', () => ({ X: () => null }))

const sellers: SellerAccount[] = [
  {
    id: 'seller-1',
    user_id: 'user-1',
    seller_id: 'miyabi-24',
    display_name: null,
    is_default: true,
    created_at: '2026-07-25T00:00:00.000Z',
  },
  {
    id: 'seller-2',
    user_id: 'user-1',
    seller_id: 'other-seller',
    display_name: null,
    is_default: false,
    created_at: '2026-07-25T00:00:00.000Z',
  },
]

const extraction: Extraction = {
  id: 'ext-1',
  user_id: 'user-1',
  source_url: 'https://example.com/search',
  source_site: 'mercari',
  seller_account_id: 'seller-1',
  category_id: 'category-1',
  bulk_edit_setting_id: null,
  status: 'completed',
  progress: 100,
  memo: '',
  is_bulk: true,
  extracted_at: null,
  error_message: null,
  created_at: '2026-07-25T00:00:00.000Z',
  updated_at: '2026-07-25T00:00:00.000Z',
  seller_account: sellers[0],
  category: {
    id: 'category-1',
    user_id: 'user-1',
    name: 'Video Games',
    ebay_category_id: '139973',
    sort_order: 0,
    created_at: '2026-07-25T00:00:00.000Z',
  },
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'product-1',
    user_id: 'user-1',
    extraction_id: 'ext-1',
    source_url: 'https://example.com/item',
    source_site: 'mercari',
    source_item_id: '1',
    original_title: 'Original',
    original_price: 6000,
    original_description: null,
    original_images: [],
    original_condition: '中古',
    ebay_title: 'eBay title',
    ebay_brand: null,
    ebay_price: 83,
    ebay_description: null,
    ebay_images: ['https://img.example/1.jpg'],
    ebay_item_specifics: {},
    ebay_condition: '中古',
    ebay_category_id: null,
    listing_status: 'draft',
    listed_at: null,
    sold_at: null,
    seller_rating_count: null,
    shipping_days: null,
    source_updated_at: null,
    purchase_price_jpy: 6000,
    price_type: 'fixed',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => [makeProduct()],
  })) as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ListingModal', () => {
  it('出品準備済みならCSV出品とSpecifics CSVを有効化する', async () => {
    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('対象商品:')).toBeTruthy())
    expect(screen.getByText('出品必須項目未設定:').parentElement).toHaveTextContent('0件')
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS用CSV出力' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'ダイレクト出品（準備中）' })).toBeDisabled()
  })

  it('抽出時と異なるセラーを選択するとCSV出力を無効化する', async () => {
    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'CSV出品' })).toBeEnabled())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '出品セラー' }), 'seller-2')
    expect(screen.getByText('抽出時に選択した出品セラーへ戻してください。')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS用CSV出力' })).toBeDisabled()
  })

  it('必須項目未設定の商品があれば出品CSVだけを無効化する', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [makeProduct({ ebay_price: null })],
    })) as unknown as typeof fetch
    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('出品必須項目未設定:').parentElement).toHaveTextContent('1件'))
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS用CSV出力' })).toBeEnabled()
  })

  it('登録セラーがない場合はセラーID入力までCSV出力を無効化する', async () => {
    render(<ListingModal extraction={{ ...extraction, seller_account_id: null, seller_account: undefined }} sellers={[]} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('対象商品:')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS用CSV出力' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: 'eBayセラーID' }), 'miyabi-24')
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS用CSV出力' })).toBeEnabled()
  })
})
