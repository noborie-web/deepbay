import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-12): 仕入先としてのAmazon、段階2。
// 検索はASIN一覧を返すだけで、抽出は始めない(抽出回数を使う前に中身を見る)。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  loadAmazonCredentials: vi.fn(),
  fetchAccessToken: vi.fn(),
  searchAmazonAsins: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }))
vi.mock('@/lib/amazon-credentials', () => ({ loadAmazonCredentials: mocks.loadAmazonCredentials }))
vi.mock('@/lib/amazon-spapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/amazon-spapi')>()
  return { ...actual, fetchAccessToken: mocks.fetchAccessToken }
})
vi.mock('@/lib/amazon-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/amazon-search')>()
  return { ...actual, searchAmazonAsins: mocks.searchAmazonAsins }
})

import { POST } from '@/app/api/amazon/search/route'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/amazon/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/amazon/search', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.loadAmazonCredentials.mockReset().mockResolvedValue({
      clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', marketplaceId: 'A1VC38T7YXB528',
    })
    mocks.fetchAccessToken.mockReset().mockResolvedValue({ accessToken: 'token', expiresInSec: 3600 })
    mocks.searchAmazonAsins.mockReset().mockResolvedValue({
      items: [{ asin: 'B000000001', title: 'テスト商品', brand: 'CASIO' }],
      truncated: false,
      requests: 1,
    })
  })

  it('検索URLからASIN一覧を返す', async () => {
    const res = await POST(request({ query: 'https://www.amazon.co.jp/s?k=casio+watch&node=2017157051', limit: 50 }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.items).toEqual([{ asin: 'B000000001', title: 'テスト商品', brand: 'CASIO' }])
    expect(json.count).toBe(1)
    expect(json.query).toEqual({
      keywords: ['casio', 'watch'], brandNames: [], classificationIds: ['2017157051'],
    })
    expect(mocks.searchAmazonAsins).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ keywords: ['casio', 'watch'], classificationIds: ['2017157051'] }),
      expect.objectContaining({ limit: 50, marketplaceId: 'A1VC38T7YXB528' }),
    )
  })

  it('取得件数の上限は300件に収める(抽出の上限と同じ)', async () => {
    await POST(request({ query: 'casio', limit: 5000 }))
    expect(mocks.searchAmazonAsins).toHaveBeenCalledWith(
      'token', expect.anything(), expect.objectContaining({ limit: 300 }),
    )
  })

  it('キーワードが読み取れなければ理由を返して検索しない', async () => {
    const res = await POST(request({ query: 'https://www.amazon.co.jp/s?node=2017157051' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('キーワード')
    expect(mocks.searchAmazonAsins).not.toHaveBeenCalled()
  })

  it('Amazon未接続なら接続を促す', async () => {
    mocks.loadAmazonCredentials.mockResolvedValue(null)
    const res = await POST(request({ query: 'casio' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('接続')
    expect(mocks.searchAmazonAsins).not.toHaveBeenCalled()
  })

  it('未ログインは401', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    expect((await POST(request({ query: 'casio' }))).status).toBe(401)
  })

  it('検索の失敗は理由をそのまま返す', async () => {
    const { AmazonSearchError } = await import('@/lib/amazon-search')
    mocks.searchAmazonAsins.mockRejectedValue(new AmazonSearchError('Amazonの検索に失敗しました: QuotaExceeded'))
    const res = await POST(request({ query: 'casio' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('QuotaExceeded')
  })
})
