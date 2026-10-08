import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-08): 「Kakehashiで出品したものだけ管理したい。1万件はいらない」
// これまでは出品時に在庫管理へ登録せず、あとの同期でeBayアカウント全体
// (実測10,072件)を走査して自分の出品を探し直していた。走査は時間切れで
// 完走せず、見つからなかった出品は在庫管理に載らないまま=仕入先チェックも
// 自動取り下げも効かない状態だった。出品した時点で登録する。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  publishFixedPriceItem: vi.fn(),
  refreshEbayAccessToken: vi.fn(),
  decryptEbayRefreshToken: vi.fn(() => 'refresh'),
  loadActiveHtmlTemplate: vi.fn(async () => null),
  inventoryUpserts: [] as Array<Record<string, unknown>>,
  productUpdates: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@/lib/ebay', () => ({
  decryptEbayRefreshToken: mocks.decryptEbayRefreshToken,
  refreshEbayAccessToken: mocks.refreshEbayAccessToken,
}))
vi.mock('@/lib/ebay-listing', () => ({ publishFixedPriceItem: mocks.publishFixedPriceItem }))
vi.mock('@/lib/html-template', () => ({ loadActiveHtmlTemplate: mocks.loadActiveHtmlTemplate }))

const product = {
  id: '11111111-2222-3333-4444-555555555555',
  user_id: 'user-1',
  listing_status: 'draft',
  ebay_title: 'Rare CD',
  ebay_price: 49.99,
  ebay_description: 'desc',
  ebay_images: ['https://example.com/a.jpg'],
  original_condition: '中古',
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      const state = { update: null as Record<string, unknown> | null }
      const query = {
        select() { return query },
        eq() { return query },
        in() { return query },
        update(payload: Record<string, unknown>) {
          state.update = payload
          if (table === 'products') mocks.productUpdates.push(payload)
          return query
        },
        upsert(payload: Record<string, unknown>) {
          if (table === 'inventory_active_listings') mocks.inventoryUpserts.push(payload)
          return Promise.resolve({ error: null })
        },
        maybeSingle: async () => {
          if (state.update) return { data: { id: product.id }, error: null }
          if (table === 'extractions') {
            return {
              data: {
                id: 'ext-1', seller_account_id: 'seller-1',
                category: { ebay_category_id: '176984', condition_map: null, default_condition_id: null },
              },
              error: null,
            }
          }
          if (table === 'seller_accounts') {
            return { data: { id: 'seller-1', seller_id: 'miyabi-24', ebay_connected_at: '2026-01-01' }, error: null }
          }
          if (table === 'ebay_account_credentials') {
            return { data: { refresh_token_encrypted: 'enc' }, error: null }
          }
          return { data: null, error: null }
        },
        then(resolve: (value: unknown) => unknown) {
          if (table === 'products') return Promise.resolve({ data: [product], error: null }).then(resolve)
          return Promise.resolve({ data: [], error: null }).then(resolve)
        },
      }
      return query
    },
  })),
}))

import { POST } from '@/app/api/ebay/listings/route'

function request() {
  return new NextRequest('https://deepbay.vercel.app/api/ebay/listings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      extractionId: 'ext-1',
      sellerAccountId: 'seller-1',
      productIds: [product.id],
      shippingProfile: 'Shipping',
      paymentProfile: 'Payment',
      returnProfile: 'Returns',
      confirmed: true,
    }),
  })
}

describe('出品に成功したら在庫管理に登録する', () => {
  beforeEach(() => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.refreshEbayAccessToken.mockResolvedValue('access-token')
    mocks.publishFixedPriceItem.mockResolvedValue({ itemId: '298731296337', warningMessages: [] })
    mocks.inventoryUpserts.length = 0
    mocks.productUpdates.length = 0
  })

  it('eBayがItemIDを返した時点で、セラー・商品・ラベルを紐付けて登録する', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)

    expect(mocks.inventoryUpserts).toHaveLength(1)
    expect(mocks.inventoryUpserts[0]).toMatchObject({
      user_id: 'user-1',
      seller_account_id: 'seller-1',
      ebay_item_id: '298731296337',
      product_id: product.id,
      // 同期がこのラベルで商品を引き当てられる形式で保存する
      custom_label: `kakehashi_${product.id.replaceAll('-', '_')}`,
      quantity: 1,
      quantity_sold: 0,
      listing_status: 'Active',
      site_id: 'US',
      currency: 'USD',
    })
  })

  it('商品も「出品済み」として保存する(従来どおり)', async () => {
    await POST(request())

    expect(mocks.productUpdates.some((update) => update.listing_status === 'listed'
      && update.ebay_item_id === '298731296337')).toBe(true)
  })
})
