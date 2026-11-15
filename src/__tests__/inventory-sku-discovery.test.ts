import { describe, expect, it, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { discoverListingsBySku, skuForProductId } from '@/lib/inventory-sync'

// 本番で確認した不具合(2026-11-15): CSV出品の取り込みをセラーで絞るのに
// extractions!inner を使っていたため、抽出リストを削除した商品
// (extraction_id が null)が1件も対象にならなかった。取り込みたかった809件は
// すべてこれに該当し、機能が丸ごと空振りしていた。

const ORPHAN_ID = '11111111-1111-4111-8111-111111111111'
const OWNED_ID = '22222222-2222-4222-8222-222222222222'

type Row = { id: string; listing_csv_exported_at: string }

/** products への問い合わせだけを見て、extraction_id の条件で返す行を変える */
function makeDb(rows: { orphans: Row[]; owned: Row[] }) {
  const queries: Array<{ orphanOnly: boolean; sellerFiltered: boolean }> = []

  function productsQuery() {
    const state = { orphanOnly: false, sellerFiltered: false }
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.select = self
    chain.eq = (column: string) => {
      if (column.startsWith('extractions.')) state.sellerFiltered = true
      return chain
    }
    chain.not = self
    chain.is = (column: string) => {
      if (column === 'extraction_id') state.orphanOnly = true
      return chain
    }
    chain.order = self
    chain.limit = async () => {
      queries.push({ ...state })
      return { data: state.orphanOnly ? rows.orphans : rows.owned, error: null }
    }
    return chain
  }

  const db = {
    from: vi.fn((table: string) => {
      if (table === 'products') return productsQuery()
      throw new Error(`unexpected table: ${table}`)
    }),
  } as unknown as SupabaseClient

  return { db, queries }
}

function sellerListXml(items: Array<{ id: string; sku: string }>): string {
  const blocks = items.map(i => `<Item>
  <ItemID>${i.id}</ItemID>
  <Title>Item ${i.id}</Title>
  <SKU>${i.sku}</SKU>
  <Quantity>1</Quantity>
  <SellingStatus><CurrentPrice currencyID="USD">100.0</CurrentPrice><QuantitySold>0</QuantitySold><ListingStatus>Active</ListingStatus></SellingStatus>
  <ListingDetails><StartTime>2026-11-10T10:00:00.000Z</StartTime></ListingDetails>
</Item>`).join('')
  return `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages><TotalNumberOfEntries>${items.length}</TotalNumberOfEntries></PaginationResult>
  <PageNumber>1</PageNumber>
  <ItemArray>${blocks}</ItemArray>
</GetSellerListResponse>`
}

describe('discoverListingsBySku', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('抽出リストが残っていない商品(extraction_id が null)も照会する', async () => {
    const exportedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const { db, queries } = makeDb({
      orphans: [{ id: ORPHAN_ID, listing_csv_exported_at: exportedAt }],
      owned: [{ id: OWNED_ID, listing_csv_exported_at: exportedAt }],
    })
    const bodies: string[] = []
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''))
      return new Response(sellerListXml([]), { status: 200 })
    }) as unknown as typeof fetch

    const result = await discoverListingsBySku(db, 'user-1', 'token', {
      sellerAccountId: 'seller-1',
      sellerSiteIds: ['US'],
    })

    // セラー不明の分と、このセラーの分の両方を引いている
    expect(queries.some(q => q.orphanOnly)).toBe(true)
    expect(queries.some(q => q.sellerFiltered)).toBe(true)
    // 両方のSKUを1回の問い合わせに載せている
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain(`<SKU>${skuForProductId(ORPHAN_ID)}</SKU>`)
    expect(bodies[0]).toContain(`<SKU>${skuForProductId(OWNED_ID)}</SKU>`)
    expect(result.skusPending).toBe(2)
  })

  it('未取り込みが無ければeBayを呼ばない', async () => {
    const { db } = makeDb({ orphans: [], owned: [] })
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const result = await discoverListingsBySku(db, 'user-1', 'token', { sellerAccountId: 'seller-1' })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ discovered: 0, skusQueried: 0, skusPending: 0, truncated: false })
  })

  it('eBayが失敗しても同期は止めず、理由を返す', async () => {
    const exportedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { db } = makeDb({ orphans: [{ id: ORPHAN_ID, listing_csv_exported_at: exportedAt }], owned: [] })
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch

    const result = await discoverListingsBySku(db, 'user-1', 'token', { sellerAccountId: 'seller-1' })

    expect(result.discovered).toBe(0)
    expect(result.error).toContain('500')
  })
})
