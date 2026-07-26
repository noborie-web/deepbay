import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getUser = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser },
  })),
}))

import { POST } from '@/app/api/ebay/listings/route'

function request(body: Record<string, unknown>) {
  return new NextRequest('https://deepbay.vercel.app/api/ebay/listings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
})

describe('POST /api/ebay/listings', () => {
  it('明示確認なしでは実出品処理を開始しない', async () => {
    const response = await POST(request({
      extractionId: 'ext-1',
      sellerAccountId: 'seller-1',
      productIds: ['product-1'],
      shippingProfile: 'Shipping',
      paymentProfile: 'Payment',
      returnProfile: 'Returns',
      confirmed: false,
    }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: '実出品の確認が必要です' })
  })

  it('1回の上限20件を超える商品IDを拒否する', async () => {
    const response = await POST(request({
      extractionId: 'ext-1',
      sellerAccountId: 'seller-1',
      productIds: Array.from({ length: 21 }, (_, index) => `product-${index}`),
      shippingProfile: 'Shipping',
      paymentProfile: 'Payment',
      returnProfile: 'Returns',
      confirmed: true,
    }))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('1〜20件')
  })

  it('未ログインなら拒否する', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } })
    const response = await POST(request({ confirmed: true }))
    expect(response.status).toBe(401)
  })
})
