import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  expireStaleInventorySyncRuns,
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
