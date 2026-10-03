import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// 本番で確認した不具合(2026-10-03): 抽出が90%のまま1時間以上「処理中」で止まり、
// 商品も0件だった。実行時間の上限(300秒)で強制終了されるとcatchも走らないため、
// 失敗として記録されず画面が回り続ける。状況確認のたびに古い「処理中」を確定させる。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  extraction: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.order = async () => ({ data: [], error: null })
      chain.single = async () => ({ data: table === 'extractions' ? mocks.extraction : null, error: null })
      return chain
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.update = (values: Record<string, unknown>) => { mocks.updates.push(values); return chain }
      chain.eq = () => chain
      chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
      return chain
    },
  })),
}))

import { GET } from '@/app/api/extraction-status/[id]/route'

function request() {
  return new NextRequest('http://localhost/api/extraction-status/ext-1')
}
const params = Promise.resolve({ id: 'ext-1' })

describe('抽出の「処理中」取り残し', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.updates.length = 0
  })

  it('古い「処理中」は失敗として確定し、理由を返す', async () => {
    mocks.extraction = {
      id: 'ext-1', status: 'processing', progress: 90,
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }
    const res = await GET(request(), { params })
    const json = await res.json()

    expect(mocks.updates[0]).toMatchObject({ status: 'failed', progress: 0 })
    expect(json.extraction.status).toBe('failed')
    expect(json.extraction.error_message).toContain('時間内に完了しませんでした')
  })

  it('始まったばかりの「処理中」は触らない', async () => {
    mocks.extraction = {
      id: 'ext-1', status: 'processing', progress: 30,
      created_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    const res = await GET(request(), { params })
    const json = await res.json()

    expect(mocks.updates).toEqual([])
    expect(json.extraction.status).toBe('processing')
  })

  it('完了済みの抽出は触らない', async () => {
    mocks.extraction = {
      id: 'ext-1', status: 'completed', progress: 100,
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }
    await GET(request(), { params })
    expect(mocks.updates).toEqual([])
  })
})
