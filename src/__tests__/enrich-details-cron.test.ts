import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-15): 抽出結果のページを開かなくても補完が進むようにしたい。
// 従来は画面がAPIを繰り返し呼ぶ作りで、ページを閉じると止まっていた。
const mocks = vi.hoisted(() => ({
  runEnrichDetailsBatch: vi.fn(),
  rows: [] as Array<{ user_id: string | null; extraction_id: string | null }>,
  selectError: null as { message: string } | null,
  notFilters: [] as unknown[][],
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => {
      const chain = {
        select: () => chain,
        in: () => chain,
        is: () => chain,
        not: (...args: unknown[]) => { mocks.notFilters.push(args); return chain },
        or: () => chain,
        order: () => chain,
        limit: async () => ({ data: mocks.rows, error: mocks.selectError }),
      }
      return chain
    },
  })),
}))
vi.mock('@/lib/enrich-details', () => ({ runEnrichDetailsBatch: mocks.runEnrichDetailsBatch }))

import { GET } from '@/app/api/cron/enrich-details/route'

function request(auth?: string) {
  return new NextRequest('http://localhost/api/cron/enrich-details', {
    headers: auth ? { authorization: auth } : {},
  })
}

describe('GET /api/cron/enrich-details', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret'
    mocks.selectError = null
    mocks.notFilters.length = 0
    mocks.runEnrichDetailsBatch.mockReset().mockResolvedValue({
      processed: 30, failed: 0, pending: 155, fleaPending: 0, retryAfterMs: 0, fleaRateLimited: false,
    })
    mocks.rows = [
      { user_id: 'user-1', extraction_id: 'extraction-1' },
      { user_id: 'user-1', extraction_id: 'extraction-1' },
      { user_id: 'user-1', extraction_id: 'extraction-2' },
    ]
  })

  it('補完待ちがいちばん古い抽出を1つ進める', async () => {
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.results).toEqual([
      { extraction_id: 'extraction-1', processed: 30, failed: 0, pending: 155, fleaPending: 0, retryAfterMs: 0, fleaRateLimited: false },
    ])
    // 実行時間(60秒)に収めるため、1回で進めるのは1抽出だけ
    expect(mocks.runEnrichDetailsBatch).toHaveBeenCalledTimes(1)
    expect(mocks.runEnrichDetailsBatch).toHaveBeenCalledWith(
      expect.anything(), { id: 'user-1' }, 'extraction-1',
    )
  })

  // 本番で確認した不具合(2026-10-16): 抽出が消えた商品(extraction_id が null)が
  // 509件あり、それが最も古い。古い順に200件取ると全部それで埋まり、
  // 「補完待ちの商品はありません」と返して何も進まなかった。
  it('抽出が消えた商品(extraction_idがnull)を対象から外す', async () => {
    await GET(request('Bearer test-secret'))
    expect(mocks.notFilters).toContainEqual(['extraction_id', 'is', null])
  })

  it('補完待ちが無ければ何もしない', async () => {
    mocks.rows = []
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual([])
    expect(mocks.runEnrichDetailsBatch).not.toHaveBeenCalled()
  })

  // 1つの抽出で落ちても、定期実行そのものは失敗させない(次回また拾う)
  it('補完に失敗しても理由を返して終わる', async () => {
    mocks.runEnrichDetailsBatch.mockRejectedValue(new Error('Yahoo rate limited'))
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(200)
    expect((await res.json()).results[0]).toMatchObject({ error: 'Yahoo rate limited' })
  })

  it('秘密鍵が無い・違うなら拒否する', async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request('Bearer wrong'))).status).toBe(401)
    expect(mocks.runEnrichDetailsBatch).not.toHaveBeenCalled()
  })

  it('商品の照会に失敗したら500（黙って「補完待ち0件」にしない）', async () => {
    mocks.selectError = { message: 'db down' }
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(500)
    expect(mocks.runEnrichDetailsBatch).not.toHaveBeenCalled()
  })
})
