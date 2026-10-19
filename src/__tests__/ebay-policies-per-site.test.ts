import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー報告(2026-10-19): akebono-32 は UK/AU に出品する設定なのに、
// 出品ポリシーの選択肢にUK用が出てこなかった。
// ポリシーをセラーの marketplaceId(EBAY_AU)だけで取っていたため。
// ビジネスポリシーはマーケットプレイスごとに別物なので、出品する全サイトぶん取る。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  seller: null as Record<string, unknown> | null,
  credential: { refresh_token_encrypted: 'enc' } as Record<string, unknown> | null,
  fetchEbayPolicies: vi.fn(),
  updated: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: table === 'seller_accounts' ? mocks.seller : mocks.credential,
              error: null,
            }),
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        mocks.updated.push(payload)
        return { eq: () => ({ eq: async () => ({ error: null }) }) }
      },
    }),
  })),
}))
vi.mock('@/lib/ebay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ebay')>()
  return {
    ...actual,
    decryptEbayRefreshToken: () => 'refresh',
    refreshEbayAccessToken: async () => 'access',
    fetchEbayPolicies: mocks.fetchEbayPolicies,
  }
})

import { GET } from '@/app/api/ebay/policies/route'

function policySet(marketplaceId: string, name: string) {
  return {
    marketplaceId,
    fulfillment: [{ id: `${marketplaceId}-f`, name }],
    payment: [{ id: `${marketplaceId}-p`, name: 'eBay Payments' }],
    return: [{ id: `${marketplaceId}-r`, name: 'Returns Accepted' }],
    syncedAt: '2026-10-19T10:00:00.000Z',
  }
}

function request(refresh = true) {
  return new NextRequest(
    `http://localhost/api/ebay/policies?sellerAccountId=seller-1${refresh ? '&refresh=1' : ''}`,
  )
}

describe('GET /api/ebay/policies', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.credential = { refresh_token_encrypted: 'enc' }
    mocks.updated.length = 0
    mocks.seller = {
      id: 'seller-1',
      ebay_marketplace_id: 'EBAY_AU',
      listing_site_ids: ['UK', 'AU'],
      ebay_policy_cache: null,
      ebay_policy_synced_at: null,
    }
    mocks.fetchEbayPolicies.mockReset().mockImplementation(
      async (_token: string, marketplaceId: string) => policySet(marketplaceId, `${marketplaceId} shipping`),
    )
  })

  it('出品する全サイトぶんのポリシーを取る（UKはEBAY_GB）', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    const json = await res.json()

    // UK の marketplaceId は EBAY_UK ではなく EBAY_GB
    const marketplaces = mocks.fetchEbayPolicies.mock.calls.map((call) => call[1]).sort()
    expect(marketplaces).toEqual(['EBAY_AU', 'EBAY_GB'])

    expect(json.sites).toEqual(['UK', 'AU'])
    expect(json.bySite.UK.fulfillment[0].name).toBe('EBAY_GB shipping')
    expect(json.bySite.AU.fulfillment[0].name).toBe('EBAY_AU shipping')
  })

  it('従来どおり単一サイトの形も返す（画面の古い読み方を壊さない）', async () => {
    const json = await (await GET(request())).json()
    // セラーの marketplaceId(EBAY_AU)に対応するサイトを既定にする
    expect(json.primarySite).toBe('AU')
    expect(json.fulfillment[0].name).toBe('EBAY_AU shipping')
  })

  it('サイト別に保存する', async () => {
    await GET(request())
    const cache = mocks.updated[0].ebay_policy_cache as { bySite: Record<string, unknown> }
    expect(Object.keys(cache.bySite).sort()).toEqual(['AU', 'UK'])
  })

  // 1サイトだけ失敗しても、取れたサイトは使えるようにする
  it('一部のサイトが失敗しても、取れた分は返す', async () => {
    mocks.fetchEbayPolicies.mockImplementation(async (_t: string, marketplaceId: string) => {
      if (marketplaceId === 'EBAY_GB') throw new Error('UK is not enabled')
      return policySet(marketplaceId, 'AU shipping')
    })
    const res = await GET(request())
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.bySite.AU).toBeTruthy()
    expect(json.bySite.UK).toBeUndefined()
    expect(json.siteErrors.UK).toContain('UK is not enabled')
  })

  it('全サイト失敗したらエラーを返す', async () => {
    mocks.fetchEbayPolicies.mockRejectedValue(new Error('token expired'))
    const res = await GET(request())
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('token expired')
  })

  // サイトを増やした直後は、古いキャッシュに無いサイトがあるので取り直す
  it('キャッシュに無いサイトがあれば取り直す', async () => {
    mocks.seller!.ebay_policy_cache = { bySite: { AU: policySet('EBAY_AU', 'AU') }, syncedAt: new Date().toISOString() }
    mocks.seller!.ebay_policy_synced_at = new Date().toISOString()
    await GET(request(false))
    expect(mocks.fetchEbayPolicies).toHaveBeenCalled()
  })
})
