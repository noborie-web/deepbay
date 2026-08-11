import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  refresh: vi.fn(),
  resolveLegacy: vi.fn(),
}))

vi.mock('@/lib/ebay', () => ({
  decryptEbayRefreshToken: mocks.decrypt,
  refreshEbayAccessToken: mocks.refresh,
}))

vi.mock('@/lib/ebay-actions', () => ({
  resolveAccessToken: mocks.resolveLegacy,
}))

import { hasInventoryAuthentication, resolveInventoryAccessToken } from '@/lib/inventory-auth'

function mockDb(credentials: Array<{ refresh_token_encrypted: string }>) {
  const credentialQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => ({ data: credentials, error: null })),
  }
  const updateEq = vi.fn(async () => ({ error: null }))
  const settingsQuery = {
    update: vi.fn().mockReturnValue({ eq: updateEq }),
  }
  const from = vi.fn((table: string) => table === 'ebay_account_credentials'
    ? credentialQuery
    : settingsQuery)

  return {
    db: { from } as unknown as SupabaseClient,
    settingsQuery,
    updateEq,
  }
}

describe('inventory authentication', () => {
  beforeEach(() => {
    mocks.decrypt.mockReset().mockReturnValue('decrypted-refresh-token')
    mocks.refresh.mockReset().mockResolvedValue('connected-access-token')
    mocks.resolveLegacy.mockReset()
  })

  it('uses the encrypted credential when exactly one seller is connected', async () => {
    const { db } = mockDb([{ refresh_token_encrypted: 'encrypted-token' }])

    await expect(resolveInventoryAccessToken(db, 'user-1', {
      ebay_token: 'legacy-token',
    })).resolves.toBe('connected-access-token')

    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-token')
    expect(mocks.refresh).toHaveBeenCalledWith('decrypted-refresh-token')
    expect(mocks.resolveLegacy).not.toHaveBeenCalled()
  })

  it('keeps the legacy token path and persists legacy refreshes as a fallback', async () => {
    const { db, settingsQuery, updateEq } = mockDb([])
    mocks.resolveLegacy.mockImplementation(async (_settings, onRefresh) => {
      await onRefresh({ accessToken: 'refreshed-legacy-token', expiresAt: new Date('2026-08-10T01:00:00.000Z') })
      return 'refreshed-legacy-token'
    })

    await expect(resolveInventoryAccessToken(db, 'user-1', {
      ebay_token: 'legacy-token',
      ebay_refresh_token: 'legacy-refresh-token',
    })).resolves.toBe('refreshed-legacy-token')

    expect(settingsQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      ebay_token: 'refreshed-legacy-token',
      ebay_token_expires_at: '2026-08-10T01:00:00.000Z',
    }))
    expect(updateEq).toHaveBeenCalledWith('user_id', 'user-1')
  })

  it('does not choose an account implicitly when multiple sellers are connected', async () => {
    const { db } = mockDb([
      { refresh_token_encrypted: 'encrypted-1' },
      { refresh_token_encrypted: 'encrypted-2' },
    ])

    await expect(resolveInventoryAccessToken(db, 'user-1', {}))
      .rejects.toThrow('複数のeBayセラーが接続されています')
  })

  it('reports automatic authentication only for exactly one connected seller', async () => {
    const single = mockDb([{ refresh_token_encrypted: 'encrypted-token' }])
    const multiple = mockDb([
      { refresh_token_encrypted: 'encrypted-1' },
      { refresh_token_encrypted: 'encrypted-2' },
    ])

    await expect(hasInventoryAuthentication(single.db, 'user-1')).resolves.toBe(true)
    await expect(hasInventoryAuthentication(multiple.db, 'user-1')).resolves.toBe(false)
  })
})
