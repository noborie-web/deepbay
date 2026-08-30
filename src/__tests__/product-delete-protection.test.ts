import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { LISTED_PRODUCT_DELETE_ERROR } from '@/lib/product-deletion'

interface Candidate {
  id: string
  ebay_item_id: string | null
  ebay_title: string | null
  original_title: string
}

const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  extractionExists: true,
  products: [] as Candidate[],
  inventoryListings: [] as { product_id: string | null }[],
  deleteTables: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user } })),
    },
    from: vi.fn(() => {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        single: vi.fn(async () => ({
          data: state.extractionExists ? { id: 'extraction-1' } : null,
          error: null,
        })),
      }
      query.select.mockReturnValue(query)
      query.eq.mockReturnValue(query)
      return query
    }),
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      let operation: 'select' | 'delete' = 'select'
      const query = {
        select: vi.fn(),
        delete: vi.fn(),
        eq: vi.fn(),
        in: vi.fn(),
        then: (
          onFulfilled: (value: { data?: unknown; error: null }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          let result: { data?: unknown; error: null }
          if (operation === 'delete') {
            state.deleteTables.push(table)
            result = { error: null }
          } else if (table === 'products') {
            result = { data: state.products, error: null }
          } else if (table === 'inventory_active_listings') {
            result = { data: state.inventoryListings, error: null }
          } else {
            result = { data: [], error: null }
          }
          return Promise.resolve(result).then(onFulfilled, onRejected)
        },
      }
      query.select.mockImplementation(() => {
        operation = 'select'
        return query
      })
      query.delete.mockImplementation(() => {
        operation = 'delete'
        return query
      })
      query.eq.mockReturnValue(query)
      query.in.mockReturnValue(query)
      return query
    }),
  })),
}))

const listedProduct: Candidate = {
  id: 'product-listed',
  ebay_item_id: 'ebay-123',
  ebay_title: 'Listed title',
  original_title: 'Original listed title',
}

const unlistedProduct: Candidate = {
  id: 'product-unlisted',
  ebay_item_id: null,
  ebay_title: null,
  original_title: 'Unlisted title',
}

describe('protected product deletion', () => {
  beforeEach(() => {
    state.user = { id: 'user-1' }
    state.extractionExists = true
    state.products = []
    state.inventoryListings = []
    state.deleteTables = []
  })

  it('blocks the entire extraction when one child product is listed', async () => {
    state.products = [unlistedProduct, listedProduct]
    const { DELETE } = await import('@/app/api/extractions/[id]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/extractions/extraction-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'extraction-1' }) },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: LISTED_PRODUCT_DELETE_ERROR,
      blockedProducts: [{ id: 'product-listed', title: 'Listed title' }],
    })
    expect(state.deleteTables).toEqual([])
  })

  it('force-deletes an extraction containing listed products', async () => {
    state.products = [listedProduct]
    const { DELETE } = await import('@/app/api/extractions/[id]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/extractions/extraction-1?force=true', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'extraction-1' }) },
    )

    expect(response.status).toBe(200)
    expect(state.deleteTables).toEqual(['products', 'extractions'])
  })

  it('deletes an extraction normally when none of its products are listed', async () => {
    state.products = [unlistedProduct]
    const { DELETE } = await import('@/app/api/extractions/[id]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/extractions/extraction-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'extraction-1' }) },
    )

    expect(response.status).toBe(200)
    expect(state.deleteTables).toEqual(['products', 'extractions'])
  })

  it('blocks a product referenced by an active inventory listing', async () => {
    state.products = [{ ...listedProduct, ebay_item_id: null }]
    state.inventoryListings = [{ product_id: listedProduct.id }]
    const { DELETE } = await import('@/app/api/products/[extractionId]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/products/extraction-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: listedProduct.id }),
      }),
      { params: Promise.resolve({ extractionId: 'extraction-1' }) },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: LISTED_PRODUCT_DELETE_ERROR,
      blockedProducts: [{ id: 'product-listed', title: 'Listed title' }],
    })
    expect(state.deleteTables).toEqual([])
  })

  it('force-deletes a listed product when force is set in the body', async () => {
    state.products = [listedProduct]
    const { DELETE } = await import('@/app/api/products/[extractionId]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/products/extraction-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: listedProduct.id, force: true }),
      }),
      { params: Promise.resolve({ extractionId: 'extraction-1' }) },
    )

    expect(response.status).toBe(200)
    expect(state.deleteTables).toEqual(['products'])
  })

  it('deletes an unlisted product normally', async () => {
    state.products = [unlistedProduct]
    const { DELETE } = await import('@/app/api/products/[extractionId]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/products/extraction-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: unlistedProduct.id }),
      }),
      { params: Promise.resolve({ extractionId: 'extraction-1' }) },
    )

    expect(response.status).toBe(200)
    expect(state.deleteTables).toEqual(['products'])
  })

  // ?check=true: 削除ボタンクリック時点で出品済みかどうかだけを判定し、実際の
  // 削除はしない(編集画面が「編集保存」まで削除を保留するために使う)。
  it('check=true does not delete an unlisted product, only reports it is deletable', async () => {
    state.products = [unlistedProduct]
    const { DELETE } = await import('@/app/api/products/[extractionId]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/products/extraction-1?check=true', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: unlistedProduct.id }),
      }),
      { params: Promise.resolve({ extractionId: 'extraction-1' }) },
    )

    expect(response.status).toBe(200)
    expect(state.deleteTables).toEqual([])
  })

  it('check=true still blocks (409) a listed product without deleting anything', async () => {
    state.products = [listedProduct]
    const { DELETE } = await import('@/app/api/products/[extractionId]/route')
    const response = await DELETE(
      new NextRequest('http://localhost/api/products/extraction-1?check=true', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: listedProduct.id }),
      }),
      { params: Promise.resolve({ extractionId: 'extraction-1' }) },
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: LISTED_PRODUCT_DELETE_ERROR,
      blockedProducts: [{ id: 'product-listed', title: 'Listed title' }],
    })
    expect(state.deleteTables).toEqual([])
  })
})
