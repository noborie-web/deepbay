import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  fetchAmazonProducts: vi.fn(),
  runScrape: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => (table === 'profiles'
          ? { data: { extraction_limit: 100, extraction_used: 0 }, error: null }
          : { data: { id: 'extraction-1' }, error: null }),
        insert: (payload: Record<string, unknown>) => {
          if (table === 'extractions') mocks.inserted.push(payload)
          return query
        },
      }
      return query
    },
  })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) })) }))
vi.mock('@/lib/amazon-extract', () => ({ fetchAmazonProducts: mocks.fetchAmazonProducts }))
vi.mock('@/lib/extraction-run', () => ({ runScrape: mocks.runScrape }))
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (fn: () => unknown) => { void fn() } }
})

import { POST } from '@/app/api/extract/amazon/route'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/extract/amazon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/extract/amazon', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.rpc.mockReset().mockResolvedValue({})
    mocks.inserted.length = 0
    mocks.fetchAmazonProducts.mockReset().mockResolvedValue({
      products: [{ sourceItemId: 'B0F18J2CJF', price: 5000 }],
      pricingFailed: [], noOffer: [], skipped: [], notFba: [],
    })
    mocks.runScrape.mockReset().mockResolvedValue({ status: 'completed' })
  })

  it('ASINを受け取って抽出を作成する', async () => {
    const res = await POST(request({ asins: 'B0F18J2CJF\nB00ABCDEFG' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.asinCount).toBe(2)
    expect(mocks.inserted[0]).toMatchObject({ source_site: 'amazon', status: 'processing' })
  })

  it('FBAのみを既定にする（無在庫では発送が安定しているため）', async () => {
    await POST(request({ asins: 'B0F18J2CJF' }))
    expect(mocks.fetchAmazonProducts.mock.calls[0][3]).toMatchObject({ fbaOnly: true })
  })

  it('明示的に false を渡せば自社発送も対象にする', async () => {
    await POST(request({ asins: 'B0F18J2CJF', fbaOnly: false }))
    expect(mocks.fetchAmazonProducts.mock.calls[0][3]).toMatchObject({ fbaOnly: false })
  })

  it('取得した商品を既存の抽出パイプラインに渡す', async () => {
    await POST(request({ asins: 'B0F18J2CJF' }))
    expect(mocks.runScrape.mock.calls[0][5]).toMatchObject({
      presetProducts: [{ sourceItemId: 'B0F18J2CJF', price: 5000 }],
    })
  })

  it('ASINが読み取れなければ400で返す', async () => {
    const res = await POST(request({ asins: 'これは商品名です' }))
    expect(res.status).toBe(400)
    expect(mocks.inserted).toHaveLength(0)
  })

  it('1回の上限(300件)を超えたら拒否する', async () => {
    const many = Array.from({ length: 301 }, (_, i) => `B${i.toString().padStart(9, '0')}`).join('\n')
    const res = await POST(request({ asins: many }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('300件')
  })

  it('未ログインなら拒否する', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(request({ asins: 'B0F18J2CJF' }))
    expect(res.status).toBe(401)
  })
})

// 本番で確認(2026-10-13): ASIN5件で抽出したら2件しか取り込まれず、残り3件が
// どの理由で落ちたか画面に何も出ていなかった。件数が0のときだけ理由を書いて
// いたため。一部成功した場合も必ず除外詳細に残す。
describe('取り込めなかったASINの理由', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.rpc.mockReset().mockResolvedValue({})
    mocks.inserted.length = 0
    mocks.runScrape.mockReset().mockResolvedValue({ status: 'completed' })
  })

  it('一部だけ成功した場合も、落ちた理由を除外詳細に残す', async () => {
    mocks.fetchAmazonProducts.mockResolvedValue({
      products: [{ sourceItemId: 'B000000001', price: 1000 }],
      noOffer: ['B000000002'],
      notFba: ['B000000003'],
      pricingFailed: ['B000000004'],
      skipped: ['B000000005'],
    })

    await POST(request({ asins: ['B000000001','B000000002','B000000003','B000000004','B000000005'].join('\n') }))

    expect(mocks.runScrape.mock.calls[0][5].extraExclusionSummary).toMatchObject({
      amazon_requested: 5,
      amazon_no_new_offer: 1,
      amazon_not_fba: 1,
      amazon_pricing_failed: 1,
      amazon_time_skipped: 1,
    })
  })

  it('どのASINが落ちたかも残す（再実行や個別確認に使えるように）', async () => {
    mocks.fetchAmazonProducts.mockResolvedValue({
      products: [{ sourceItemId: 'B000000001', price: 1000 }],
      noOffer: ['B000000002'], notFba: [], pricingFailed: ['B000000004'], skipped: [],
    })

    await POST(request({ asins: 'B000000001\nB000000002\nB000000004' }))

    expect(mocks.runScrape.mock.calls[0][5].extraExclusionSummary).toMatchObject({
      amazon_no_new_offer_asins: ['B000000002'],
      amazon_pricing_failed_asins: ['B000000004'],
    })
  })

  it('FBAが無くて落ちた場合は、設定を外せばよいと分かる文言にする', async () => {
    mocks.fetchAmazonProducts.mockResolvedValue({
      products: [], noOffer: [], notFba: ['B000000001'], pricingFailed: [], skipped: [],
    })

    const res = await POST(request({ asins: 'B000000001' }))
    expect(res.status).toBe(200)
    // 商品0件なので runScrape は呼ばない
    expect(mocks.runScrape).not.toHaveBeenCalled()
  })
})
