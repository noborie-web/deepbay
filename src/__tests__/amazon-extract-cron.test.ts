import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-18): Amazon抽出の分割実行を定期実行(pg_cron)でも進める。
// #282 の自己呼び出しは1回でも失敗するとそこで止まるが、定期実行なら
// 次の回で拾い直せる。動いているジョブを二重に走らせないよう、
// しばらく進んでいないものだけを対象にする。
const mocks = vi.hoisted(() => ({
  processChunkAndChain: vi.fn(),
  jobs: [] as Array<Record<string, unknown>>,
  selectError: null as { message: string } | null,
  filters: [] as Array<[string, unknown]>,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => {
      const chain = {
        select: () => chain,
        in: () => chain,
        lt: (column: string, value: unknown) => { mocks.filters.push([column, value]); return chain },
        order: () => chain,
        limit: async () => ({ data: mocks.jobs, error: mocks.selectError }),
      }
      return chain
    },
  })),
}))
vi.mock('@/lib/amazon-job', () => ({ processChunkAndChain: mocks.processChunkAndChain }))

import { GET } from '@/app/api/cron/amazon-extract/route'

function request(auth?: string) {
  return new NextRequest('http://localhost/api/cron/amazon-extract', {
    headers: auth ? { authorization: auth } : {},
  })
}

describe('GET /api/cron/amazon-extract', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret'
    mocks.selectError = null
    mocks.filters.length = 0
    mocks.processChunkAndChain.mockReset().mockResolvedValue(undefined)
    mocks.jobs = [{ id: 'job-1', extraction_id: 'extraction-1', next_index: 300, status: 'pending' }]
  })

  it('止まっているジョブを続きから進める', async () => {
    const res = await GET(request('Bearer test-secret'))
    expect(res.status).toBe(200)
    expect((await res.json()).resumed).toMatchObject({ job_id: 'job-1', from_index: 300 })
    expect(mocks.processChunkAndChain).toHaveBeenCalledWith('job-1', 'extraction-1', 'http://localhost')
  })

  // 自己呼び出しで動いている最中のジョブを二重に走らせない
  it('直近に進んだジョブは対象にしない（10分の猶予を置く）', async () => {
    await GET(request('Bearer test-secret'))
    const [column, value] = mocks.filters[0]
    expect(column).toBe('last_progress_at')
    const cutoff = Date.parse(String(value))
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000)
    expect(Date.now() - cutoff).toBeLessThan(11 * 60 * 1000)
  })

  it('止まっているジョブが無ければ何もしない', async () => {
    mocks.jobs = []
    const res = await GET(request('Bearer test-secret'))
    expect((await res.json()).resumed).toBeNull()
    expect(mocks.processChunkAndChain).not.toHaveBeenCalled()
  })

  it('秘密鍵が無い・違うなら拒否する', async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request('Bearer wrong'))).status).toBe(401)
    expect(mocks.processChunkAndChain).not.toHaveBeenCalled()
  })

  it('ジョブの照会に失敗したら500（黙って「無し」にしない）', async () => {
    mocks.selectError = { message: 'db down' }
    expect((await GET(request('Bearer test-secret'))).status).toBe(500)
    expect(mocks.processChunkAndChain).not.toHaveBeenCalled()
  })
})
