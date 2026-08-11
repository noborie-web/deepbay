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

  it('aborts an eBay page request that exceeds the timeout', async () => {
    fetchMock.mockImplementation((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
    }))

    await expect(fetchAllActiveListings(
      { accessToken: 'oauth-user-token' },
      { pageTimeoutMs: 5, totalTimeoutMs: 50 },
    )).rejects.toThrow('eBay API timeout: page 1 exceeded 5ms')

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(request.signal?.aborted).toBe(true)
  })

  it('fetches remaining pages concurrently and preserves page order', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0

    fetchMock.mockImplementation(async (_url: string, request: RequestInit) => {
      const page = Number(String(request.body).match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1])
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeRequests -= 1

      return new Response(`
        <GetMyeBaySellingResponse>
          <Ack>Success</Ack>
          <ActiveList>
            <ItemArray>
              <Item><ItemID>${page}</ItemID><Title>Page ${page}</Title></Item>
            </ItemArray>
            <PaginationResult>
              <TotalNumberOfPages>4</TotalNumberOfPages>
              <PageNumber>${page}</PageNumber>
            </PaginationResult>
          </ActiveList>
        </GetMyeBaySellingResponse>
      `, { status: 200 })
    })

    const listings = await fetchAllActiveListings(
      { accessToken: 'oauth-user-token' },
      { concurrency: 3 },
    )

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(maxActiveRequests).toBe(3)
    expect(listings.map((listing) => listing.ebayItemId)).toEqual(['1', '2', '3', '4'])
  })
})
