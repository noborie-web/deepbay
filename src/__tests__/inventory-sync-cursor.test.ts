import { describe, expect, it } from 'vitest'
import { createInventorySyncCursor, parseInventorySyncCursor } from '@/lib/inventory-sync-cursor'

describe('inventory sync cursor', () => {
  it('round-trips the run and next page', () => {
    const cursor = createInventorySyncCursor('run-1', 5, 'secret')

    expect(parseInventorySyncCursor(cursor, 'secret')).toEqual({
      version: 1,
      runId: 'run-1',
      nextPage: 5,
      sellerIndex: 0,
    })
  })

  // 出品アカウントを複数運用する場合、次に処理するセラーの位置も引き継ぐ
  it('round-trips the seller position for multi-account sync', () => {
    const cursor = createInventorySyncCursor('run-1', 1, 'secret', 1)

    expect(parseInventorySyncCursor(cursor, 'secret')).toEqual({
      version: 1,
      runId: 'run-1',
      nextPage: 1,
      sellerIndex: 1,
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
    expect(() => createInventorySyncCursor('run-1', 0, 'secret'))
      .toThrow('Invalid inventory sync cursor values')
    // 最初のセラーの1バッチ目は「継続」ではないためカーソルにできない
    expect(() => createInventorySyncCursor('run-1', 1, 'secret'))
      .toThrow('Invalid inventory sync cursor values')
    expect(() => createInventorySyncCursor('run-1', 2, 'secret', -1))
      .toThrow('Invalid inventory sync cursor values')
  })
})
