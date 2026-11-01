import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  expireStaleInventorySyncRuns,
  isPermanentItemError,
  INVENTORY_SYNC_STALE_MESSAGE,
  summarizeInventoryActionRun,
} from '@/lib/inventory-run'

describe('summarizeInventoryActionRun', () => {
  it('marks a fully successful run as completed', () => {
    expect(summarizeInventoryActionRun([{ success: true }, { success: true }])).toEqual({
      status: 'completed',
      errorMessage: null,
    })
  })

  it('uses the DB-supported failed status when any action fails', () => {
    expect(summarizeInventoryActionRun([
      { success: true },
      { success: false, error: 'first error' },
    ])).toEqual({
      status: 'failed',
      errorMessage: '1/2件失敗: first error',
    })
  })

  it('limits stored error details while preserving the failure count', () => {
    const summary = summarizeInventoryActionRun([
      { success: false, error: 'error 1' },
      { success: false, error: 'error 2' },
      { success: false, error: 'error 3' },
      { success: false, error: 'error 4' },
    ])

    expect(summary.errorMessage).toBe('4/4件失敗: error 1 / error 2 / error 3')
  })
})

describe('expireStaleInventorySyncRuns', () => {
  it('marks only old running sync records as failed', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      lt: vi.fn().mockResolvedValue({ error: null }),
    }
    const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient
    const now = new Date('2026-08-11T04:40:00.000Z')

    await expireStaleInventorySyncRuns(db, 'user-1', now)

    expect(db.from).toHaveBeenCalledWith('inventory_runs')
    expect(chain.update).toHaveBeenCalledWith({
      status: 'failed',
      error_message: INVENTORY_SYNC_STALE_MESSAGE,
      finished_at: now.toISOString(),
    })
    expect(chain.eq).toHaveBeenNthCalledWith(1, 'user_id', 'user-1')
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'run_type', 'sync')
    expect(chain.eq).toHaveBeenNthCalledWith(3, 'status', 'running')
    expect(chain.lt).toHaveBeenCalledWith('started_at', '2026-08-11T04:38:00.000Z')
  })

  it('surfaces cleanup failures before a new sync starts', async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      lt: vi.fn().mockResolvedValue({ error: { message: 'database unavailable' } }),
    }
    const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient

    await expect(expireStaleInventorySyncRuns(db, 'user-1'))
      .rejects.toThrow('Failed to expire stale inventory sync runs: database unavailable')
  })
})

// 本番で確認した問題(2026-11-01): 価格改定は9回すべて status:'failed' だったが、
// 実際は毎回95%以上成功しており、失敗は常に同じ5件だけだった(重複出品4件・
// 削除済みの出品1件)。どれもeBay側を直すまで解消しない。これで実行全体を
// 失敗にすると、本当の失敗がこの5件に埋もれて気づけない。
describe('eBay側の事情で解消しない失敗の扱い', () => {
  const duplicate = 'It looks like this listing is for an item you already have on eBay: Rare LIVRE Light Arm 65'
  const deleted = 'This item cannot be accessed because the listing has been deleted or you are not the seller.'

  it('全件成功なら理由を残さない', () => {
    expect(summarizeInventoryActionRun([{ success: true }, { success: true }]))
      .toEqual({ status: 'completed', errorMessage: null })
  })

  it('eBay側の事情だけなら稼働扱いにし、理由は残す', () => {
    const result = summarizeInventoryActionRun([
      ...Array.from({ length: 17 }, () => ({ success: true })),
      { success: false, error: duplicate },
      { success: false, error: duplicate },
      { success: false, error: duplicate },
      { success: false, error: duplicate },
      { success: false, error: deleted },
    ])

    // ここが本題。修正前は status:'failed' だった
    expect(result.status).toBe('completed')
    expect(result.errorMessage).toContain('5/22件はeBay側の事情でスキップ')
    expect(result.errorMessage).toContain('再試行しても解消しません')
  })

  it('こちらで対処すべき失敗が混ざっていれば失敗にする', () => {
    const result = summarizeInventoryActionRun([
      { success: true },
      { success: false, error: duplicate },
      { success: false, error: 'eBay API HTTP error: 500' },
    ])

    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('1/3件失敗')
    // eBay側の分も埋もれさせず、件数だけは添える
    expect(result.errorMessage).toContain('ほかに1件はeBay側の事情でスキップ')
    expect(result.errorMessage).toContain('eBay API HTTP error: 500')
  })

  it('理由が無い失敗は、こちらで対処すべき失敗として扱う', () => {
    expect(summarizeInventoryActionRun([{ success: false }]).status).toBe('failed')
  })

  it('isPermanentItemError は2つのeBayエラーだけを恒久的と判定する', () => {
    expect(isPermanentItemError(duplicate)).toBe(true)
    expect(isPermanentItemError(deleted)).toBe(true)
    expect(isPermanentItemError('eBay API HTTP error: 500')).toBe(false)
    expect(isPermanentItemError(undefined)).toBe(false)
    expect(isPermanentItemError(null)).toBe(false)
  })
})
