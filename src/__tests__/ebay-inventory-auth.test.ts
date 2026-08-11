import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAllActiveListings } from '@/lib/ebay-inventory'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('eBay inventory OAuth authentication', () => {
  it('sends the OAuth user token only in the IAF header', async () => {
    fetchMock.mockResolvedValue(new Response(`
      <GetMyeBaySellingResponse>
        <Ack>Success</Ack>
        <ActiveList>
          <ItemArray></ItemArray>
          <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
        </ActiveList>
        <PageNumber>1</PageNumber>
      </GetMyeBaySellingResponse>
    `, { status: 200 }))

    await expect(fetchAllActiveListings({ accessToken: 'oauth-user-token' })).resolves.toEqual([])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(request.headers).toMatchObject({
      'X-EBAY-API-IAF-TOKEN': 'oauth-user-token',
    })
    expect(request.headers).not.toMatchObject({
      'X-EBAY-API-DEV-NAME': expect.anything(),
      'X-EBAY-API-APP-NAME': expect.anything(),
      'X-EBAY-API-CERT-NAME': expect.anything(),
    })

    const body = String(request.body)
    expect(body).not.toContain('oauth-user-token')
    expect(body).not.toContain('RequesterCredentials')
    expect(body).not.toContain('eBayAuthToken')
  })
})
