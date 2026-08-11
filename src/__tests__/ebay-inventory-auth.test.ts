import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchActiveListingsBatch, fetchAllActiveListings } from '@/lib/ebay-inventory'

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
    expect(body).toContain('<DetailLevel>ReturnAll</DetailLevel>')
    expect(body).toContain('<OutputSelector>PaginationResult</OutputSelector>')
    expect(body).toContain('<OutputSelector>ItemID</OutputSelector>')
    expect(body).toContain('<OutputSelector>CurrentPrice</OutputSelector>')
    expect(body).toContain('<OutputSelector>QuantitySold</OutputSelector>')
    expect(body).not.toContain('<OutputSelector>Ack</OutputSelector>')
    expect(body).not.toContain('<OutputSelector>Errors</OutputSelector>')
    expect(body).not.toContain('<OutputSelector>Description</OutputSelector>')
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

  it('keeps the page timeout active while reading the response body', async () => {
    fetchMock.mockImplementation(async (_url: string, request: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    }) as Response)

    await expect(fetchAllActiveListings(
      { accessToken: 'oauth-user-token' },
      { pageTimeoutMs: 5, totalTimeoutMs: 50 },
    )).rejects.toThrow('eBay API timeout: page 1 exceeded 5ms')
  })

  it('aborts all page requests when the total timeout is exceeded', async () => {
    fetchMock.mockImplementation((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
    }))

    await expect(fetchAllActiveListings(
      { accessToken: 'oauth-user-token' },
      { pageTimeoutMs: 100, totalTimeoutMs: 5 },
    )).rejects.toThrow('eBay inventory sync timeout: exceeded 5ms')
  })

  it('retries one timed-out page once and then continues', async () => {
    const attempts = new Map<number, number>()

    fetchMock.mockImplementation(async (_url: string, request: RequestInit) => {
      const page = Number(String(request.body).match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1])
      const attempt = (attempts.get(page) ?? 0) + 1
      attempts.set(page, attempt)

      if (page === 2 && attempt === 1) {
        return await new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }

      return new Response(`
        <GetMyeBaySellingResponse>
          <Ack>Success</Ack>
          <ActiveList>
            <ItemArray>
              <Item><ItemID>${page}</ItemID><Title>Page ${page}</Title></Item>
            </ItemArray>
            <PaginationResult>
              <TotalNumberOfPages>2</TotalNumberOfPages>
              <PageNumber>${page}</PageNumber>
            </PaginationResult>
          </ActiveList>
        </GetMyeBaySellingResponse>
      `, { status: 200 })
    })

    const listings = await fetchAllActiveListings(
      { accessToken: 'oauth-user-token' },
      { pageTimeoutMs: 5, totalTimeoutMs: 50 },
    )

    expect(attempts.get(1)).toBe(1)
    expect(attempts.get(2)).toBe(2)
    expect(listings.map(listing => listing.ebayItemId)).toEqual(['1', '2'])
  })

  it('uses bounded default concurrency and preserves page order', async () => {
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
              <TotalNumberOfPages>9</TotalNumberOfPages>
              <PageNumber>${page}</PageNumber>
            </PaginationResult>
          </ActiveList>
        </GetMyeBaySellingResponse>
      `, { status: 200 })
    })

    const listings = await fetchAllActiveListings({ accessToken: 'oauth-user-token' })

    expect(fetchMock).toHaveBeenCalledTimes(9)
    expect(maxActiveRequests).toBe(8)
    expect(listings.map((listing) => listing.ebayItemId)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
    ])
  })

  it('fetches a bounded resumable page range', async () => {
    fetchMock.mockImplementation(async (_url: string, request: RequestInit) => {
      const page = Number(String(request.body).match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1])
      return new Response(`
        <GetMyeBaySellingResponse>
          <Ack>Success</Ack>
          <ActiveList>
            <ItemArray><Item><ItemID>${page}</ItemID><Title>Page ${page}</Title></Item></ItemArray>
            <PaginationResult>
              <TotalNumberOfPages>9</TotalNumberOfPages>
              <PageNumber>${page}</PageNumber>
            </PaginationResult>
          </ActiveList>
        </GetMyeBaySellingResponse>
      `, { status: 200 })
    })

    const result = await fetchActiveListingsBatch(
      { accessToken: 'oauth-user-token' },
      5,
      3,
    )

    expect(result.items.map(item => item.ebayItemId)).toEqual(['5', '6', '7'])
    expect(result).toMatchObject({ nextPage: 8, totalPages: 9, lastFetchedPage: 7 })
  })
})
