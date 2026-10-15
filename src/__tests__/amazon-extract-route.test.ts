import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にして新品無在庫でeBayに出品する。
// 2026-10-14に300件上限を上げた。ルートは抽出とジョブを作るところまでを受け持ち、
// 実際の取得はチャンクごとの処理(amazon-job.ts)に任せる。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  processChunkAndChain: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>,
  jobInserted: [] as Array<Record<string, unknown>>,
  jobInsertError: null as { message: string } | null,
  extractionUpdates: [] as Array<Record<string, unknown>>,
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

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === 'amazon_extract_jobs') {
        return {
          insert: (payload: Record<string, unknown>) => {
            mocks.jobInserted.push(payload)
            return {
              select: () => ({
                single: async () => (mocks.jobInsertError
                  ? { data: null, error: mocks.jobInsertError }
                  : { data: { id: 'job-1' }, error: null }),
              }),
            }
          },
        }
      }
      return {
        update: (payload: Record<string, unknown>) => {
          mocks.extractionUpdates.push(payload)
          return { eq: async () => ({ error: null }) }
        },
      }
    },
  })),
}))

vi.mock('@/lib/amazon-job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/amazon-job')>()
  return { ...actual, processChunkAndChain: mocks.processChunkAndChain }
})

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

function asinList(count: number): string {
  return Array.from({ length: count }, (_, i) => `B${i.toString().padStart(9, '0')}`).join('\n')
}

describe('POST /api/extract/amazon', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.rpc.mockReset().mockResolvedValue({})
    mocks.processChunkAndChain.mockReset().mockResolvedValue(undefined)
    mocks.inserted.length = 0
    mocks.jobInserted.length = 0
    mocks.extractionUpdates.length = 0
    mocks.jobInsertError = null
  })

  it('ASINを受け取って抽出とジョブを作成する', async () => {
    const res = await POST(request({ asins: 'B0F18J2CJF\nB00ABCDEFG' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ asinCount: 2, chunks: 1, jobId: 'job-1' })
    expect(mocks.inserted[0]).toMatchObject({ source_site: 'amazon', status: 'processing' })
    expect(mocks.jobInserted[0]).toMatchObject({
      extraction_id: 'extraction-1', chunk_size: 300, fba_only: true, status: 'pending',
    })
    expect(mocks.jobInserted[0].asins).toEqual(['B0F18J2CJF', 'B00ABCDEFG'])
  })

  // 300件は「2 ASIN/s × 150秒」で、1回の実行での限界。
  // それ以上は300件ずつに分けて複数回の実行で仕上げる。
  it('300件を超えたら300件ずつのチャンクに分ける', async () => {
    const res = await POST(request({ asins: asinList(700) }))
    const json = await res.json()
    expect(json).toMatchObject({ asinCount: 700, chunks: 3 })
    // 実効2 ASIN/s なので 700件 = 350秒
    expect(json.estimatedSec).toBe(350)
  })

  it('FBAのみを既定にする（無在庫では発送が安定しているため）', async () => {
    await POST(request({ asins: 'B0F18J2CJF' }))
    expect(mocks.jobInserted[0]).toMatchObject({ fba_only: true })
  })

  it('明示的に false を渡せば自社発送も対象にする', async () => {
    await POST(request({ asins: 'B0F18J2CJF', fbaOnly: false }))
    expect(mocks.jobInserted[0]).toMatchObject({ fba_only: false })
  })

  it('ASINが読み取れなければ400で返す', async () => {
    const res = await POST(request({ asins: 'これは商品名です' }))
    expect(res.status).toBe(400)
    expect(mocks.inserted).toHaveLength(0)
  })

  it('1回の上限(2,000件)を超えたら拒否する', async () => {
    const res = await POST(request({ asins: asinList(2001) }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('2000件')
    expect(mocks.inserted).toHaveLength(0)
  })

  it('未ログインなら拒否する', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    expect((await POST(request({ asins: 'B0F18J2CJF' }))).status).toBe(401)
  })

  // ジョブが作れないと取得が一切動かないので、抽出を「処理中」のまま残さない
  it('ジョブを作れなければ抽出を失敗にする', async () => {
    mocks.jobInsertError = { message: 'insert failed' }
    const res = await POST(request({ asins: 'B0F18J2CJF' }))
    expect(res.status).toBe(500)
    expect(mocks.extractionUpdates[0]).toMatchObject({ status: 'failed' })
    expect(mocks.processChunkAndChain).not.toHaveBeenCalled()
  })
})
