import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// ユーザー要望(2026-10-14): Amazon抽出の300件上限を上げる。
// 1回の実行では300件(2 ASIN/s × 150秒)が限界なので、ASINを分割して
// 複数回の実行で1つの抽出を仕上げる。

const mocks = vi.hoisted(() => ({
  fetchAmazonProducts: vi.fn(),
  runScrape: vi.fn(),
}))

vi.mock('@/lib/amazon-extract', () => ({ fetchAmazonProducts: mocks.fetchAmazonProducts }))
vi.mock('@/lib/extraction-run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/extraction-run')>()
  return { ...actual, runScrape: mocks.runScrape }
})

import { CHUNK_SIZE, runAmazonExtractChunk } from '@/lib/amazon-job'
import { mergeExclusionSummaries } from '@/lib/extraction-run'

interface JobRow {
  id: string
  user_id: string
  extraction_id: string
  asins: string[]
  next_index: number
  chunk_size: number
  fba_only: boolean
  bulk_edit_setting_id: string | null
  status: string
  summary: Record<string, unknown>
}

function dbFor(job: JobRow) {
  const jobUpdates: Array<Record<string, unknown>> = []
  const extractionUpdates: Array<Record<string, unknown>> = []
  const db = {
    from: (table: string) => {
      if (table === 'amazon_extract_jobs') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: job, error: null }) }),
          }),
          update: (payload: Record<string, unknown>) => {
            jobUpdates.push(payload)
            // 実際のDBと同じく、更新をジョブに反映する
            Object.assign(job, payload)
            return { eq: async () => ({ error: null }) }
          },
        }
      }
      if (table === 'extractions') {
        return {
          update: (payload: Record<string, unknown>) => {
            extractionUpdates.push(payload)
            return { eq: () => ({ eq: async () => ({ error: null }) }), then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  } as unknown as SupabaseClient
  return { db, jobUpdates, extractionUpdates }
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    user_id: 'user-1',
    extraction_id: 'extraction-1',
    asins: Array.from({ length: 700 }, (_, i) => `B${String(i).padStart(9, '0')}`),
    next_index: 0,
    chunk_size: CHUNK_SIZE,
    fba_only: true,
    bulk_edit_setting_id: null,
    status: 'pending',
    summary: {},
    ...overrides,
  }
}

function fetched(count: number, overrides: Record<string, string[]> = {}) {
  return {
    products: Array.from({ length: count }, (_, i) => ({ title: `p${i}` })),
    pricingFailed: [], noOffer: [], skipped: [], notFba: [],
    ...overrides,
  }
}

describe('runAmazonExtractChunk', () => {
  beforeEach(() => {
    mocks.fetchAmazonProducts.mockReset().mockResolvedValue(fetched(300))
    mocks.runScrape.mockReset().mockImplementation(async (_u, _e, _url, _b, _db, opts) =>
      ({ status: 'completed', exclusionSummary: mergeExclusionSummaries(opts.previousExclusionSummary, opts.extraExclusionSummary ?? {}), savedCount: 300 }))
  })

  it('1回の呼び出しで300件だけ処理し、続きがあると返す', async () => {
    const { db, jobUpdates } = dbFor(job())
    const result = await runAmazonExtractChunk(db, 'job-1')

    expect(result).toEqual({ done: false, processed: 300, nextIndex: 300, total: 700 })
    expect(mocks.fetchAmazonProducts.mock.calls[0][2]).toHaveLength(300)
    // 途中のチャンクは「完了」にしない(抽出回数も数えない)
    expect(mocks.runScrape.mock.calls[0][5]).toMatchObject({ finalize: false })
    expect(jobUpdates.at(-1)).toMatchObject({ next_index: 300, status: 'pending' })
  })

  it('続きのチャンクは前回の位置から処理する', async () => {
    const { db } = dbFor(job({ next_index: 300 }))
    const result = await runAmazonExtractChunk(db, 'job-1')
    expect(result.nextIndex).toBe(600)
    expect(mocks.fetchAmazonProducts.mock.calls[0][2][0]).toBe('B000000300')
  })

  it('最後のチャンクだけ抽出を完了にする', async () => {
    const { db, jobUpdates } = dbFor(job({ next_index: 600 }))
    mocks.fetchAmazonProducts.mockResolvedValue(fetched(100))
    const result = await runAmazonExtractChunk(db, 'job-1')

    expect(result).toEqual({ done: true, processed: 100, nextIndex: 700, total: 700 })
    expect(mocks.runScrape.mock.calls[0][5]).toMatchObject({ finalize: true })
    expect(jobUpdates.at(-1)).toMatchObject({ status: 'completed' })
  })

  // 時間切れで処理しなかったASINを「処理済み」として飛ばすと、永久に
  // 取り込まれないまま終わる(既存ツールで価格0を確定させた事故と同じ構図)
  it('時間切れで処理しなかったASINは次のチャンクで拾い直す', async () => {
    const { db } = dbFor(job())
    mocks.fetchAmazonProducts.mockResolvedValue(
      fetched(180, { skipped: Array.from({ length: 120 }, (_, i) => `B${String(180 + i).padStart(9, '0')}`) }),
    )
    const result = await runAmazonExtractChunk(db, 'job-1')
    // 300件中180件だけ処理した → 次は180から
    expect(result).toEqual({ done: false, processed: 180, nextIndex: 180, total: 700 })
  })

  it('チャンクごとの除外内訳を足し合わせる', async () => {
    const { db, jobUpdates } = dbFor(job({
      next_index: 300,
      summary: { amazon_no_new_offer: 5, amazon_no_new_offer_asins: ['B000000001'] },
    }))
    mocks.fetchAmazonProducts.mockResolvedValue(fetched(297, { noOffer: ['B000000301', 'B000000302', 'B000000303'] }))
    await runAmazonExtractChunk(db, 'job-1')

    expect(jobUpdates.at(-1)?.summary).toMatchObject({
      amazon_no_new_offer: 8,
      amazon_no_new_offer_asins: ['B000000001', 'B000000301', 'B000000302', 'B000000303'],
    })
  })

  it('1件も取り込めないチャンクがあっても抽出は続ける', async () => {
    const { db, jobUpdates } = dbFor(job())
    mocks.fetchAmazonProducts.mockResolvedValue(fetched(0, { noOffer: Array.from({ length: 300 }, (_, i) => `B${String(i).padStart(9, '0')}`) }))
    const result = await runAmazonExtractChunk(db, 'job-1')

    expect(result.done).toBe(false)
    expect(mocks.runScrape).not.toHaveBeenCalled()
    expect(jobUpdates.at(-1)).toMatchObject({ status: 'pending', next_index: 300 })
  })

  it('完了済みのジョブは何もしない(二重処理しない)', async () => {
    const { db } = dbFor(job({ status: 'completed', next_index: 700 }))
    const result = await runAmazonExtractChunk(db, 'job-1')
    expect(result).toEqual({ done: true, processed: 0, nextIndex: 700, total: 700 })
    expect(mocks.fetchAmazonProducts).not.toHaveBeenCalled()
  })

  it('進捗はASINの処理済み割合に合わせる(チャンクをまたいでも戻らない)', async () => {
    const { db } = dbFor(job({ next_index: 300 }))
    await runAmazonExtractChunk(db, 'job-1')
    expect(mocks.runScrape.mock.calls[0][5]).toMatchObject({ progressRange: { from: 43, to: 86 } })
  })
})

// 本番で確認(2026-10-13): ASIN5件で抽出したら2件しか取り込まれず、残り3件が
// どの理由で落ちたか画面に何も出ていなかった。一部成功した場合も必ず残す。
describe('取り込めなかったASINの理由', () => {
  beforeEach(() => {
    mocks.runScrape.mockReset().mockImplementation(async (_u, _e, _url, _b, _db, opts) =>
      ({ status: 'completed', exclusionSummary: mergeExclusionSummaries(opts.previousExclusionSummary, opts.extraExclusionSummary ?? {}), savedCount: 1 }))
  })

  it('一部だけ成功した場合も、落ちた理由と対象ASINを残す', async () => {
    const { db } = dbFor(job({ asins: ['B000000001', 'B000000002', 'B000000003', 'B000000004'] }))
    mocks.fetchAmazonProducts.mockResolvedValue({
      products: [{ title: 'p1' }],
      noOffer: ['B000000002'],
      notFba: ['B000000003'],
      pricingFailed: ['B000000004'],
      skipped: [],
    })

    await runAmazonExtractChunk(db, 'job-1')

    expect(mocks.runScrape.mock.calls[0][5].extraExclusionSummary).toMatchObject({
      amazon_requested: 4,
      amazon_no_new_offer: 1,
      amazon_not_fba: 1,
      amazon_pricing_failed: 1,
      amazon_no_new_offer_asins: ['B000000002'],
      amazon_not_fba_asins: ['B000000003'],
      amazon_pricing_failed_asins: ['B000000004'],
    })
  })

  it('1件も取り込めずに終わったら、FBAを外せばよいと分かる文言を残す', async () => {
    const { db, extractionUpdates } = dbFor(job({ asins: ['B000000001'] }))
    mocks.fetchAmazonProducts.mockResolvedValue({
      products: [], noOffer: [], notFba: ['B000000001'], pricingFailed: [], skipped: [],
    })

    const result = await runAmazonExtractChunk(db, 'job-1')

    expect(result.done).toBe(true)
    expect(mocks.runScrape).not.toHaveBeenCalled()
    const failed = extractionUpdates.find(u => u.status === 'failed')
    expect(failed?.error_message).toContain('FBAのみ')
  })
})

describe('mergeExclusionSummaries', () => {
  it('数は合計し、配列は連結し、真偽値はどれかが真なら真', () => {
    expect(mergeExclusionSummaries(
      { completed_count: 10, ai_time_limited: false, asins: ['a'] },
      { completed_count: 5, ai_time_limited: true, asins: ['b'] },
    )).toEqual({ completed_count: 15, ai_time_limited: true, asins: ['a', 'b'] })
  })

  it('前のチャンクが無ければそのまま返す', () => {
    expect(mergeExclusionSummaries(undefined, { completed_count: 5 })).toEqual({ completed_count: 5 })
  })
})
