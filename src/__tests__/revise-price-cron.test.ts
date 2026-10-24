import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  revise: vi.fn(),
  inserts: [] as Array<Record<string, unknown>>,
  settings: [] as Array<Record<string, unknown>>,
  settingsError: null as { message: string } | null,
  queryCalls: [] as Array<[string, ...unknown[]]>,
}))

vi.mock('@/lib/inventory-revise-price', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inventory-revise-price')>()),
  runRevisePriceForUser: mocks.revise,
}))
vi.mock('@/lib/ebay-call-counter', () => ({ flushEbayCallCounts: vi.fn(async () => {}) }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'inventory_runs') {
        // 記録は開始時に insert().select() で作り、完了時に update() する
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            const saved = { ...row }
            mocks.inserts.push(saved)
            const res = {
              select: () => ({ maybeSingle: async () => ({ data: { id: 'run-1' }, error: null }) }),
              then: (resolve: (v: unknown) => void) => resolve({ error: null }),
            }
            return res
          }),
          update: vi.fn((row: Record<string, unknown>) => ({
            eq: async () => { Object.assign(mocks.inserts[mocks.inserts.length - 1], row); return { error: null } },
          })),
        }
      }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) {
        chain[m] = vi.fn((...args: unknown[]) => { mocks.queryCalls.push([m, ...args]); return chain })
      }
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: mocks.settings, error: mocks.settingsError })
      return chain
    }),
  })),
}))

function request(token = 'cron-secret', qs = '') {
  return new NextRequest(`http://localhost/api/cron/revise-price${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /api/cron/revise-price', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'key'
    mocks.inserts.length = 0
    mocks.queryCalls.length = 0
    mocks.settingsError = null
    mocks.settings = [{ user_id: 'u1', auto_revise_price: true }]
    mocks.revise.mockReset().mockResolvedValue({
      summary: { total: 3, succeeded: 3, deferred: 0, skipped_no_rate: 0, guarded: 0, skipped_unknown_seller: 0, unchanged: 1, items: [] },
      status: 'completed',
      errorMessage: null,
    })
  })

  it('CRON_SECRET が違えば実行しない', async () => {
    const { GET } = await import('@/app/api/cron/revise-price/route')
    const res = await GET(request('wrong'))
    expect(res.status).toBe(401)
    expect(mocks.revise).not.toHaveBeenCalled()
  })

  it('価格改定を実行して結果を必ず記録する', async () => {
    const { GET } = await import('@/app/api/cron/revise-price/route')
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(mocks.revise).toHaveBeenCalledOnce()
    const run = mocks.inserts.find(r => r.run_type === 'auto_revise_price')
    expect(run).toBeTruthy()
    expect(run?.status).toBe('completed')
  })

  // 本番で確認した不具合(2026-10-23): 価格改定の記録が1件も残らず、ONにして
  // いるのに動いていないことに丸一日気づけなかった。失敗も必ず残す。
  it('途中で例外が出ても failed として記録する', async () => {
    mocks.revise.mockRejectedValue(new Error('eBayが応答しません'))
    const { GET } = await import('@/app/api/cron/revise-price/route')
    await GET(request())
    const run = mocks.inserts.find(r => r.run_type === 'auto_revise_price')
    expect(run?.status).toBe('failed')
    expect(run?.error_message).toContain('eBayが応答しません')
  })

  it('設定の取得に失敗したら黙って0人にせずエラーを返す', async () => {
    mocks.settingsError = { message: 'boom' }
    const { GET } = await import('@/app/api/cron/revise-price/route')
    const res = await GET(request())
    expect(res.status).toBe(500)
    expect(mocks.revise).not.toHaveBeenCalled()
  })

  it('価格改定がOFFのユーザーは対象にしない', async () => {
    const { GET } = await import('@/app/api/cron/revise-price/route')
    await GET(request())
    expect(mocks.queryCalls).toContainEqual(['eq', 'auto_revise_price', true])
    expect(mocks.queryCalls).toContainEqual(['eq', 'sync_enabled', true])
  })
})
