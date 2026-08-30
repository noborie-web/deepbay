// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import ListingModal from '@/components/extraction/ListingModal'
import type { Extraction, Product, SellerAccount } from '@/types/database'

vi.mock('lucide-react', () => ({ X: () => null, RefreshCw: () => null }))

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
  exclusion_summary: null,
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
  it('eBay接続済みセラーのビジネスポリシーを取得して選択できる', async () => {
    const connectedSeller: SellerAccount = {
      ...sellers[0],
      ebay_user_id: 'ebay-user-1',
      ebay_marketplace_id: 'EBAY_US',
      ebay_connected_at: '2026-07-26T00:00:00.000Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/products/')) {
        return { ok: true, json: async () => [makeProduct()] }
      }
      if (url.startsWith('/api/ebay/policies')) {
        return {
          ok: true,
          json: async () => ({
            marketplaceId: 'EBAY_US',
            fulfillment: [
              { id: 'f1', name: 'US Shipping', marketplaceId: 'EBAY_US', categoryTypes: [] },
              { id: 'f2', name: 'Worldwide Shipping', marketplaceId: 'EBAY_US', categoryTypes: [] },
            ],
            payment: [
              { id: 'p1', name: 'eBay Managed Payments', marketplaceId: 'EBAY_US', categoryTypes: [] },
            ],
            return: [
              { id: 'r1', name: 'Returns 60 Days', marketplaceId: 'EBAY_US', categoryTypes: [] },
            ],
            syncedAt: '2026-07-26T00:00:00.000Z',
          }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(
      <ListingModal
        extraction={{ ...extraction, seller_account: connectedSeller }}
        sellers={[connectedSeller]}
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: '出品ポリシー選択方法' })).toHaveValue('ebay')
      expect(screen.getByRole('combobox', { name: '配送ポリシー' })).toHaveValue('US Shipping')
    })
    expect(screen.getByRole('combobox', { name: '支払ポリシー' })).toHaveValue('eBay Managed Payments')
    expect(screen.getByRole('combobox', { name: '返品ポリシー' })).toHaveValue('Returns 60 Days')
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '配送ポリシー' }),
      'Worldwide Shipping',
    )
    expect(screen.getByRole('combobox', { name: '配送ポリシー' })).toHaveValue('Worldwide Shipping')
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'ダイレクト出品' })).toBeEnabled()
  })

  it('eBay再同期ボタンはキャッシュを無視して取得する', async () => {
    const connectedSeller: SellerAccount = {
      ...sellers[0],
      ebay_connected_at: '2026-07-26T00:00:00.000Z',
    }
    const policyResponse = {
      marketplaceId: 'EBAY_US',
      fulfillment: [{ id: 'f1', name: 'Shipping', marketplaceId: 'EBAY_US', categoryTypes: [] }],
      payment: [{ id: 'p1', name: 'Payment', marketplaceId: 'EBAY_US', categoryTypes: [] }],
      return: [{ id: 'r1', name: 'Returns', marketplaceId: 'EBAY_US', categoryTypes: [] }],
      syncedAt: '2026-07-26T00:00:00.000Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url.startsWith('/api/products/')
        ? { ok: true, json: async () => [makeProduct()] }
        : { ok: true, json: async () => policyResponse }
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(
      <ListingModal
        extraction={{ ...extraction, seller_account: connectedSeller }}
        sellers={[connectedSeller]}
        onClose={vi.fn()}
      />,
    )
    const syncButton = await screen.findByRole('button', { name: 'eBayと再同期' })
    await waitFor(() => expect(syncButton).toBeEnabled())
    await userEvent.click(syncButton)
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('refresh=1'))).toBe(true)
    })
  })

  it('ダイレクト出品は確認チェック後だけ実行する', async () => {
    const connectedSeller: SellerAccount = {
      ...sellers[0],
      ebay_user_id: 'ebay-user-1',
      ebay_marketplace_id: 'EBAY_US',
      ebay_connected_at: '2026-07-26T00:00:00.000Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/products/')) {
        return { ok: true, json: async () => [makeProduct()] }
      }
      if (url.startsWith('/api/ebay/policies')) {
        return {
          ok: true,
          json: async () => ({
            marketplaceId: 'EBAY_US',
            fulfillment: [{ id: 'f1', name: 'Shipping', marketplaceId: 'EBAY_US', categoryTypes: [] }],
            payment: [{ id: 'p1', name: 'Payment', marketplaceId: 'EBAY_US', categoryTypes: [] }],
            return: [{ id: 'r1', name: 'Returns', marketplaceId: 'EBAY_US', categoryTypes: [] }],
            syncedAt: '2026-07-26T00:00:00.000Z',
          }),
        }
      }
      if (url === '/api/ebay/listings') {
        expect(init?.method).toBe('POST')
        const body = JSON.parse(String(init?.body))
        expect(body).toMatchObject({
          extractionId: 'ext-1',
          sellerAccountId: 'seller-1',
          productIds: ['product-1'],
          confirmed: true,
        })
        return {
          ok: true,
          json: async () => ({
            ok: true,
            succeeded: [{ productId: 'product-1', itemId: '1234567890', warnings: [] }],
            failed: [],
            requested: 1,
          }),
        }
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    global.fetch = fetchMock as unknown as typeof fetch

    render(
      <ListingModal
        extraction={{ ...extraction, seller_account: connectedSeller }}
        sellers={[connectedSeller]}
        onClose={vi.fn()}
      />,
    )
    const directButton = await screen.findByRole('button', { name: 'ダイレクト出品' })
    await waitFor(() => expect(directButton).toBeEnabled())
    await userEvent.click(directButton)
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/ebay/listings')).toHaveLength(0)

    const finalButton = screen.getByRole('button', { name: 'eBayへ1件出品' })
    expect(finalButton).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', {
      name: '内容を確認し、eBayへ実際に出品することに同意します',
    }))
    expect(finalButton).toBeEnabled()
    await userEvent.click(finalButton)

    expect(await screen.findByText('1件をeBayへ出品しました。')).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/ebay/listings')).toHaveLength(1)
  })

  it('出品準備済みならCSV出品とSpecifics CSVを有効化する', async () => {
    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('対象商品:')).toBeTruthy())
    expect(screen.getByText('出品必須項目未設定:').parentElement).toHaveTextContent('0件')
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS-IN 45列CSV出力' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'ダイレクト出品' })).toBeDisabled()
  })

  it('抽出時と異なるセラーを選択するとCSV出力を無効化する', async () => {
    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'CSV出品' })).toBeEnabled())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '出品セラー' }), 'seller-2')
    expect(screen.getByText('抽出時に選択した出品セラーへ戻してください。')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS-IN 45列CSV出力' })).toBeDisabled()
  })

  it('必須項目未設定の商品があれば出品CSVだけを無効化する', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [makeProduct({ ebay_price: null })],
    })) as unknown as typeof fetch
    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('出品必須項目未設定:').parentElement).toHaveTextContent('1件'))
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS-IN 45列CSV出力' })).toBeEnabled()
  })

  it('登録セラーがない場合はセラーID入力までCSV出力を無効化する', async () => {
    render(<ListingModal extraction={{ ...extraction, seller_account_id: null, seller_account: undefined }} sellers={[]} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('対象商品:')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS-IN 45列CSV出力' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: 'eBayセラーID' }), 'miyabi-24')
    expect(screen.getByRole('button', { name: 'CSV出品' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'SPECIFICS-IN 45列CSV出力' })).toBeEnabled()
  })

  it('45列保証ヘッダーがない旧CSVはダウンロードせずエラーにする', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeProduct()],
      })
      .mockResolvedValueOnce(new Response('CustomLabel,Title,Category\r\n1,T,C', {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      }))
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    const button = await screen.findByRole('button', { name: 'SPECIFICS-IN 45列CSV出力' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '旧形式のCSVが返されたためダウンロードを中止しました',
    )
    const [requestUrl, requestInit] = fetchMock.mock.calls[1]
    expect(String(requestUrl)).toContain('formatVersion=specificsin-45-v1')
    expect(String(requestUrl)).toContain('requestId=')
    expect(requestInit).toEqual({ cache: 'no-store' })
  })

  it('42列保証ヘッダーがない旧出品CSVはダウンロードしない', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [makeProduct()],
      })
      .mockResolvedValueOnce(new Response('Action,Title\r\nAdd,T', {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      }))
    global.fetch = fetchMock as unknown as typeof fetch

    render(<ListingModal extraction={extraction} sellers={sellers} onClose={vi.fn()} />)
    const button = await screen.findByRole('button', { name: 'CSV出品' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '旧形式の出品CSVが返されたためダウンロードを中止しました',
    )
    const [requestUrl, requestInit] = fetchMock.mock.calls[1]
    expect(String(requestUrl)).toContain('formatVersion=ebay-upload-42-v1')
    expect(String(requestUrl)).toContain('requestId=')
    expect(requestInit).toEqual({ cache: 'no-store' })
  })
})
