import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-14): Amazon抽出の300件上限を上げる。
// チャンクが終わるごとにこのエンドポイントを呼び直して続きを処理する。
// 呼び出し元は「自動継続(CRON_SECRET)」と「画面の続きを実行(本人)」の2つ。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  loadJob: vi.fn(),
  processChunkAndChain: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }))
vi.mock('@/lib/amazon-job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/amazon-job')>()
  return { ...actual, loadJob: mocks.loadJob, processChunkAndChain: mocks.processChunkAndChain }
})
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (fn: () => unknown) => { void fn() } }
})

import { POST } from '@/app/api/extract/amazon/continue/route'

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/extract/amazon/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/extract/amazon/continue', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret'
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.processChunkAndChain.mockReset().mockResolvedValue(undefined)
    mocks.loadJob.mockReset().mockResolvedValue({
      id: 'job-1', user_id: 'user-1', extraction_id: 'extraction-1',
      asins: ['B000000001', 'B000000002'], next_index: 1, chunk_size: 300,
      fba_only: true, bulk_edit_setting_id: null, status: 'pending', summary: {},
    })
  })

  it('自動継続(CRON_SECRET)で続きを処理する', async () => {
    const res = await POST(request({ jobId: 'job-1' }, { Authorization: 'Bearer test-secret' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ started: true, nextIndex: 1, total: 2 })
    expect(mocks.processChunkAndChain).toHaveBeenCalledWith('job-1', 'extraction-1', 'http://localhost')
    // 自動継続ではログインを確認しない
    expect(mocks.getUser).not.toHaveBeenCalled()
  })

  // 自動継続が途切れたとき、画面の「続きを実行」から再開できる
  it('ログイン中の本人なら、秘密鍵なしでも再開できる', async () => {
    const res = await POST(request({ jobId: 'job-1' }))
    expect(res.status).toBe(200)
    expect(mocks.processChunkAndChain).toHaveBeenCalled()
  })

  it('他人のジョブは再開できない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-2' } } })
    const res = await POST(request({ jobId: 'job-1' }))
    expect(res.status).toBe(403)
    expect(mocks.processChunkAndChain).not.toHaveBeenCalled()
  })

  it('未ログイン・秘密鍵なしなら拒否する', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(request({ jobId: 'job-1' }))
    expect(res.status).toBe(401)
    expect(mocks.processChunkAndChain).not.toHaveBeenCalled()
  })

  it('間違った秘密鍵ではログイン確認に回す(素通りさせない)', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(request({ jobId: 'job-1' }, { Authorization: 'Bearer wrong' }))
    expect(res.status).toBe(401)
  })

  it('完了済みのジョブは二重に処理しない', async () => {
    mocks.loadJob.mockResolvedValue({
      id: 'job-1', user_id: 'user-1', extraction_id: 'extraction-1',
      asins: ['B000000001'], next_index: 1, chunk_size: 300,
      fba_only: true, bulk_edit_setting_id: null, status: 'completed', summary: {},
    })
    const res = await POST(request({ jobId: 'job-1' }, { Authorization: 'Bearer test-secret' }))
    expect(await res.json()).toMatchObject({ done: true })
    expect(mocks.processChunkAndChain).not.toHaveBeenCalled()
  })

  it('ジョブが無ければ404', async () => {
    mocks.loadJob.mockResolvedValue(null)
    const res = await POST(request({ jobId: 'missing' }, { Authorization: 'Bearer test-secret' }))
    expect(res.status).toBe(404)
  })

  it('jobIdが無ければ400', async () => {
    expect((await POST(request({}, { Authorization: 'Bearer test-secret' }))).status).toBe(400)
  })
})
