import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addFixedPriceItem, endItem, resolveAccessToken, revisePrice, reviseQuantityToZero } from '@/lib/ebay-actions'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('eBay action response handling', () => {
  it('accepts an explicit Success response', async () => {
    fetchMock.mockResolvedValue(new Response('<EndItemResponse><Ack>Success</Ack></EndItemResponse>', { status: 200 }))

    await expect(endItem('token', 'item-1')).resolves.toEqual({ itemId: 'item-1', success: true })
  })

  it('accepts Warning as a successful action', async () => {
    fetchMock.mockResolvedValue(new Response('<ReviseInventoryStatusResponse><Ack>Warning</Ack></ReviseInventoryStatusResponse>', { status: 200 }))

    await expect(reviseQuantityToZero('token', 'item-1')).resolves.toEqual({ itemId: 'item-1', success: true })
  })

  it('returns a failure for PartialFailure', async () => {
    fetchMock.mockResolvedValue(new Response(`
      <ReviseInventoryStatusResponse>
        <Ack>PartialFailure</Ack>
        <Errors><LongMessage>Revision was rejected</LongMessage></Errors>
      </ReviseInventoryStatusResponse>
    `, { status: 200 }))

    await expect(revisePrice('token', 'item-1', 12.5)).resolves.toEqual({
      itemId: 'item-1',
      success: false,
      error: 'Revision was rejected',
    })
  })

  it('returns a failure for HTTP errors', async () => {
    fetchMock.mockResolvedValue(new Response('<Errors><LongMessage>Service unavailable</LongMessage></Errors>', { status: 503 }))

    const result = await endItem('token', 'item-1')
    expect(result).toMatchObject({ itemId: 'item-1', success: false })
    expect(result.error).toContain('503: Service unavailable')
  })

  it.each([
    ['', 'empty response'],
    ['<html>not an eBay response</html>', 'did not include Ack'],
  ])('returns a failure for an invalid response', async (body, expectedError) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }))

    const result = await endItem('token', 'item-1')
    expect(result).toMatchObject({ itemId: 'item-1', success: false })
    expect(result.error).toContain(expectedError)
  })

  it('returns a failure instead of throwing on network errors', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'))

    await expect(endItem('token', 'item-1')).resolves.toEqual({
      itemId: 'item-1',
      success: false,
      error: 'network unavailable',
    })
  })

  it('requires ItemID on a successful AddFixedPriceItem response', async () => {
    fetchMock.mockResolvedValue(new Response('<AddFixedPriceItemResponse><Ack>Success</Ack></AddFixedPriceItemResponse>', { status: 200 }))

    const result = await addFixedPriceItem('token', {
      title: 'Title',
      price: 10,
      categoryId: '1',
      description: 'Description',
      pictureUrls: [],
      sku: 'sku-1',
      paymentProfileName: 'Payment',
      returnProfileName: 'Return',
      shippingProfileName: 'Shipping',
    })

    expect(result).toEqual({ success: false, error: 'eBay API response did not include ItemID' })
  })

  it('persists a refreshed access token before returning it', async () => {
    vi.stubEnv('EBAY_CLIENT_ID', 'client-id')
    vi.stubEnv('EBAY_CLIENT_SECRET', 'client-secret')
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: 'refreshed-token',
      expires_in: 7200,
    }), { status: 200 }))
    const persist = vi.fn().mockResolvedValue(undefined)

    const token = await resolveAccessToken({
      ebay_token: 'expired-token',
      ebay_refresh_token: 'refresh-token',
      ebay_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
    }, persist)

    expect(token).toBe('refreshed-token')
    expect(persist).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith({
      accessToken: 'refreshed-token',
      expiresAt: expect.any(Date),
    })

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = new URLSearchParams(String(request.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-token')
    expect(body.has('scope')).toBe(false)
  })
})
