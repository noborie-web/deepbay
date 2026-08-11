import { describe, expect, it } from 'vitest'
import { summarizeInventoryActionRun } from '@/lib/inventory-run'

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
