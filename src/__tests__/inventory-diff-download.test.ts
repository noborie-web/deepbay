import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望: 「公式ツールはタイトルの差分も検知しています」。
// 差分検知ファイル(diff)は、仕入先チェックで保存した仕入先の最新タイトル・
// 最新価格(円)が抽出時から変わった商品を、公式ツールと同じ列で出力する。
let mockUser: { id: string; email?: string } | null = { id: 'user-1', email: 'seller@example.com' }
let mockListings: Array<Record<string, unknown>> = []
let mockProducts: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: mockUser } })) },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_active_listings') {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn(async () => ({ data: mockListings, error: null })) }
      }
      if (table === 'products') {
        return { select: vi.fn().mockReturnThis(), in: vi.fn(async () => ({ data: mockProducts, error: null })) }
      }
      throw new Error(`Unexpected table: ${table}`)
    }),
  })),
}))

describe('POST /api/inventory/runs/download diff CSV', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1', email: 'seller@example.com' }
    mockListings = [
      {
        ebay_item_id: 'item-title', title: 'eBay title', custom_label: 'kakehashi_1', current_price: 100, quantity: 1, product_id: 'p-title',
        supplier_title: 'ポロ ジャケット(最新)', supplier_price_jpy: 18700, supplier_diff: ['title'],
      },
      {
        ebay_item_id: 'item-price', title: 'eBay title 2', custom_label: 'kakehashi_2', current_price: 80, quantity: 1, product_id: 'p-price',
        supplier_title: 'ピンバッジ', supplier_price_jpy: 7500, supplier_diff: ['price'],
      },
      {
        ebay_item_id: 'item-same', title: 'eBay title 3', custom_label: 'kakehashi_3', current_price: 50, quantity: 1, product_id: 'p-same',
        supplier_title: '同じ', supplier_price_jpy: 3000, supplier_diff: [],
      },
    ]
    mockProducts = [
      { id: 'p-title', source_url: 'https://snkrdunk.com/x', ebay_title: 'eBay title', ebay_price: 100, original_title: 'ポロ ジャケット', original_price: 18700 },
      { id: 'p-price', source_url: 'https://jp.mercari.com/item/m1', ebay_title: 'eBay title 2', ebay_price: 80, original_title: 'ピンバッジ', original_price: 8500 },
      { id: 'p-same', source_url: 'https://jp.mercari.com/item/m2', ebay_title: 'eBay title 3', ebay_price: 50, original_title: '同じ', original_price: 3000 },
    ]
  })

  const request = (body: unknown) => new NextRequest('http://localhost/api/inventory/runs/download', {
    method: 'POST', body: JSON.stringify(body),
  })

  it('仕入先のタイトル・価格が変わった商品だけを公式ツールと同じ列で出力する', async () => {
    const { POST } = await import('@/app/api/inventory/runs/download/route')
    const res = await POST(request({ file_type: 'diff', diff_columns: ['title', 'price'] }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.filename).toMatch(/^seller_diff_\d{8}\.csv$/)
    expect(json.csv).toContain('"1_item_id","2_url","3_旧タイトル","4_最新タイトル","5_旧価格","6_最新価格","diff_detail"')
    expect(json.csv).toContain('"item-title","https://snkrdunk.com/x","ポロ ジャケット","ポロ ジャケット(最新)","18700","18700","[""title""]"')
    expect(json.csv).toContain('"item-price","https://jp.mercari.com/item/m1","ピンバッジ","ピンバッジ","8500","7500","[""price""]"')
    expect(json.csv).not.toContain('item-same')
  })

  it('差分検知項目で絞り込める(タイトルのみ)', async () => {
    const { POST } = await import('@/app/api/inventory/runs/download/route')
    const res = await POST(request({ file_type: 'diff', diff_columns: ['title'] }))
    const json = await res.json()

    expect(json.csv).toContain('item-title')
    expect(json.csv).not.toContain('item-price')
  })
})
