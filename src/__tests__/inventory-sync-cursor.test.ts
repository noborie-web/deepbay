import { describe, expect, it } from 'vitest'
import { createInventorySyncCursor, parseInventorySyncCursor } from '@/lib/inventory-sync-cursor'

describe('inventory sync cursor', () => {
  it('round-trips the run and next page', () => {
    const cursor = createInventorySyncCursor('run-1', 5, 'secret')

    expect(parseInventorySyncCursor(cursor, 'secret')).toEqual({
      version: 1,
      runId: 'run-1',
      nextPage: 5,
    })
  })

  it('rejects a modified cursor', () => {
    const cursor = createInventorySyncCursor('run-1', 5, 'secret')
    const [payload, signature] = cursor.split('.')
    const changedPayload = Buffer.from(JSON.stringify({
      version: 1,
      runId: 'run-1',
      nextPage: 25,
    })).toString('base64url')

    expect(() => parseInventorySyncCursor(`${changedPayload}.${signature}`, 'secret'))
      .toThrow('Invalid inventory sync cursor')
    expect(payload).not.toBe(changedPayload)
  })

  it('rejects invalid page values', () => {
    expect(() => createInventorySyncCursor('run-1', 1, 'secret'))
      .toThrow('Invalid inventory sync cursor values')
  })
})
