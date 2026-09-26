import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSellerListPage, scanSellerListByStartTime } from '@/lib/ebay-inventory'

// ユーザー要望・実データで確認した不具合: CSVでeBayに出品した11件が「新しい順
// 400件」の走査に含まれず下書きのまま残った。出品開始日時で絞った
// GetSellerListで、前回走査以降の出品を全件確認する。
function sellerListXml(items: Array<{ id: string; sku?: string; status?: string }>, page: number, totalPages: number): string {
  const blocks = items.map(i => `<Item>
  <ItemID>${i.id}</ItemID>
  <Title>Item ${i.id}</Title>
  ${i.sku ? `<SKU>${i.sku}</SKU>` : ''}
  <Quantity>1</Quantity>
  <SellingStatus><CurrentPrice currencyID="USD">100.0</CurrentPrice><QuantitySold>0</QuantitySold><ListingStatus>${i.status ?? 'Active'}</ListingStatus></SellingStatus>
  <ListingDetails><StartTime>2026-09-20T10:00:00.000Z</StartTime></ListingDetails>
</Item>`).join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <PaginationResult><TotalNumberOfPages>${totalPages}</TotalNumberOfPages><TotalNumberOfEntries>${items.length}</TotalNumberOfEntries></PaginationResult>
  <PageNumber>${page}</PageNumber>
  <ItemArray>${blocks}</ItemArray>
</GetSellerListResponse>`
}

describe('fetchSellerListPage', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('GetSellerListに出品開始日時の範囲とページを渡し、SKU付きで出品を返す', async () => {
    let body = ''
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '')
      expect(String((init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME'])).toBe('GetSellerList')
      return new Response(sellerListXml([{ id: '111', sku: 'kakehashi_aaaa' }, { id: '222' }], 2, 3), { status: 200 })
    }) as unknown as typeof fetch

    const from = new Date('2026-09-19T00:00:00.000Z')
    const to = new Date('2026-09-21T00:00:00.000Z')
    const result = await fetchSellerListPage({ accessToken: 't' }, { from, to }, 2)

    expect(body).toContain('<StartTimeFrom>2026-09-19T00:00:00.000Z</StartTimeFrom>')
    expect(body).toContain('<StartTimeTo>2026-09-21T00:00:00.000Z</StartTimeTo>')
    expect(body).toContain('<PageNumber>2</PageNumber>')
    expect(result.totalPages).toBe(3)
    expect(result.items.map(i => [i.ebayItemId, i.customLabel])).toEqual([['111', 'kakehashi_aaaa'], ['222', null]])
  })

  it('120日を超える期間は拒否する', async () => {
    const from = new Date('2026-01-01T00:00:00.000Z')
    const to = new Date('2026-09-21T00:00:00.000Z')
    await expect(fetchSellerListPage({ accessToken: 't' }, { from, to }, 1)).rejects.toThrow('120 days')
  })
})

describe('scanSellerListByStartTime', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('全ページを順に読み、読み切れたら truncated=false', async () => {
    const pages: number[] = []
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const page = Number(String(init?.body ?? '').match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1])
      pages.push(page)
      return new Response(sellerListXml([{ id: `p${page}` }], page, 3), { status: 200 })
    }) as unknown as typeof fetch

    const result = await scanSellerListByStartTime(
      { accessToken: 't' },
      { from: new Date('2026-09-19T00:00:00.000Z'), to: new Date('2026-09-21T00:00:00.000Z') },
      { timeBudgetMs: 60_000 },
    )
    expect(pages).toEqual([1, 2, 3])
    expect(result.items.map(i => i.ebayItemId)).toEqual(['p1', 'p2', 'p3'])
    expect(result).toMatchObject({ truncated: false, pagesFetched: 3, totalPages: 3 })
  })

  it('時間予算を使い切ったら途中で止め truncated=true を返す', async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const page = Number(String(init?.body ?? '').match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1])
      await new Promise(r => setTimeout(r, 30))
      return new Response(sellerListXml([{ id: `p${page}` }], page, 50), { status: 200 })
    }) as unknown as typeof fetch

    const result = await scanSellerListByStartTime(
      { accessToken: 't' },
      { from: new Date('2026-09-19T00:00:00.000Z'), to: new Date('2026-09-21T00:00:00.000Z') },
      { timeBudgetMs: 1_050 },
    )
    expect(result.truncated).toBe(true)
    expect(result.pagesFetched).toBeGreaterThanOrEqual(1)
    expect(result.pagesFetched).toBeLessThan(50)
  })
})

// 本番で確認した不具合(2026-09-26): akebono-32(UK/AU)の走査が
// 「seller list page 1 exceeded 10000ms」で毎回タイムアウトし、UKに出品した
// 127件が在庫管理に入らなかった。1ページを小さくして応答を軽くする。
describe('GetSellerListの重さ対策', () => {
  it('1ページ50件で要求し、商品紐付けに必要なSKUが返るDetailLevelを維持する', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return {
        ok: true,
        text: async () => `<GetSellerListResponse><Ack>Success</Ack>
          <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult>
          <PageNumber>1</PageNumber></GetSellerListResponse>`,
      } as unknown as Response
    }))

    const { fetchSellerListPage } = await import('@/lib/ebay-inventory')
    await fetchSellerListPage({ accessToken: 'token' },
      { from: new Date('2026-09-25T00:00:00Z'), to: new Date('2026-09-26T00:00:00Z') }, 1, { siteId: 'UK' })

    expect(bodies[0]).toContain('<EntriesPerPage>50</EntriesPerPage>')
    expect(bodies[0]).toContain('<DetailLevel>ReturnAll</DetailLevel>')
    expect(bodies[0]).toContain('<OutputSelector>SKU</OutputSelector>')
    vi.unstubAllGlobals()
  })
})
