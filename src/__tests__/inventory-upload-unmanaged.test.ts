import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー報告(2026-10-08): 商品レコードが失われたKakehashi出品は、CSV取込でも
// 捨てられていた(API同期側は #265 で保存するようにしたが、取込側は未対応だった)。
// 捨てると在庫管理に載らず、存在にも気づけない。
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))
vi.mock('@/lib/inventory-sync', () => ({ applyListingStateToProducts: vi.fn(async () => {}) }))

import { POST } from '@/app/api/inventory/upload/route'

const KNOWN_PRODUCT = 'abcdef01-0000-4000-8000-000000000000'
const LOST_PRODUCT = 'ee63e9c7-90ca-4ea8-a978-b96f6c410220'

const CSV = [
  'Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity',
  `111,kakehashi_${KNOWN_PRODUCT.replace(/-/g, '_')},Managed item,82.24,1,0`,
  // 商品レコードが失われたKakehashi出品
  `298731296337,kakehashi_${LOST_PRODUCT.replace(/-/g, '_')},VW Bus Crane Truck,155.71,1,0`,
  // 他ツールの出品(Kakehashiの印なし)
  `999,other-tool-sku-123,Someone else item,10.00,1,0`,
].join('\n')

function makeDb(captured: { rows: Record<string, unknown>[]; runUpdates: Record<string, unknown>[] }) {
  return {
    from(table: string) {
      if (table === 'seller_accounts') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) chain[m] = () => chain
        chain.maybeSingle = async () => ({ data: { id: 'seller-a' }, error: null })
        return chain
      }
      if (table === 'inventory_runs') {
        const chain: Record<string, unknown> = {}
        chain.insert = () => chain
        chain.select = () => chain
        chain.single = async () => ({ data: { id: 'run-1' }, error: null })
        chain.update = (payload: Record<string, unknown>) => {
          captured.runUpdates.push(payload)
          return { eq: async () => ({ error: null }) }
        }
        return chain
      }
      if (table === 'products') {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        // 失われた商品は返さない
        chain.in = async (column: string, values: string[]) => ({
          data: column === 'id' ? values.filter(id => id === KNOWN_PRODUCT).map(id => ({ id })) : [],
          error: null,
        })
        chain.update = () => ({ eq: () => ({ in: async () => ({ error: null }) }) })
        return chain
      }
      const chain: Record<string, unknown> = {}
      chain.delete = () => chain
      chain.eq = () => chain
      chain.upsert = async (rows: Record<string, unknown>[]) => { captured.rows.push(...rows); return { error: null } }
      chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
      return chain
    },
  }
}

function uploadRequest() {
  const form = new FormData()
  form.set('file', new File([CSV], 'active.csv', { type: 'text/csv' }))
  return new NextRequest('http://localhost/api/inventory/upload?sellerAccountId=seller-a&siteId=US', {
    method: 'POST', body: form,
  })
}

describe('CSV取込: 商品レコードが失われたKakehashi出品', () => {
  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('捨てずに保存し、商品データなしとして数える', async () => {
    const captured = { rows: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[] }
    mocks.createServiceClient.mockReturnValue(makeDb(captured))

    const res = await POST(uploadRequest())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ total: 3, matched: 1, unmanaged: 1 })

    // 他ツールの出品は保存しない
    expect(captured.rows.map(row => row.ebay_item_id).sort()).toEqual(['111', '298731296337'])
    const lost = captured.rows.find(row => row.ebay_item_id === '298731296337')
    expect(lost?.product_id).toBeNull()
    expect(lost?.title).toBe('VW Bus Crane Truck')
  })

  it('稼働状況にも件数を残す', async () => {
    const captured = { rows: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[] }
    mocks.createServiceClient.mockReturnValue(makeDb(captured))

    await POST(uploadRequest())

    const completed = captured.runUpdates.find(update => update.status === 'completed')
    expect(completed).toMatchObject({ items_total: 3, items_matched: 1, result_summary: { unmanaged: 1 } })
  })
})

// 本番で発生した事故(2026-10-08): 列名が読めず0件マッチだったCSVの取込で、
// 先に既存スナップショットを削除していたため miyabi-24 の895件が消えた
// (「対象 1935件 / 更新 0件」)。削除は入れ替える中身が確定してから行う。
describe('CSV取込: 1件も一致しない場合', () => {
  const NO_MATCH_CSV = [
    'Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity',
    '999,other-tool-sku-1,Someone else item,10.00,1,0',
    '998,other-tool-sku-2,Another item,20.00,1,0',
  ].join('\n')

  function noMatchRequest() {
    const form = new FormData()
    form.set('file', new File([NO_MATCH_CSV], 'active.csv', { type: 'text/csv' }))
    return new NextRequest('http://localhost/api/inventory/upload?sellerAccountId=seller-a&siteId=US', {
      method: 'POST', body: form,
    })
  }

  function makeDbTracking(captured: {
    rows: Record<string, unknown>[]
    runUpdates: Record<string, unknown>[]
    deleted: boolean
  }) {
    return {
      from(table: string) {
        if (table === 'seller_accounts') {
          const chain: Record<string, unknown> = {}
          for (const m of ['select', 'eq']) chain[m] = () => chain
          chain.maybeSingle = async () => ({ data: { id: 'seller-a' }, error: null })
          return chain
        }
        if (table === 'inventory_runs') {
          const chain: Record<string, unknown> = {}
          chain.insert = () => chain
          chain.select = () => chain
          chain.single = async () => ({ data: { id: 'run-1' }, error: null })
          chain.update = (payload: Record<string, unknown>) => {
            captured.runUpdates.push(payload)
            return { eq: async () => ({ error: null }) }
          }
          return chain
        }
        if (table === 'products') {
          const chain: Record<string, unknown> = {}
          chain.select = () => chain
          chain.eq = () => chain
          chain.in = async () => ({ data: [], error: null })
          chain.update = () => ({ eq: () => ({ in: async () => ({ error: null }) }) })
          return chain
        }
        const chain: Record<string, unknown> = {}
        chain.delete = () => { captured.deleted = true; return chain }
        chain.eq = () => chain
        chain.upsert = async (rows: Record<string, unknown>[]) => { captured.rows.push(...rows); return { error: null } }
        chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
        return chain
      },
    }
  }

  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('既存の在庫管理を削除せず、エラーで中断する', async () => {
    const captured = { rows: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[], deleted: false }
    mocks.createServiceClient.mockReturnValue(makeDbTracking(captured))

    const res = await POST(noMatchRequest())
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(captured.deleted).toBe(false)
    expect(captured.rows).toHaveLength(0)
    expect(json.error).toContain('既存の在庫管理は変更していません')
  })

  it('稼働状況に失敗として記録する', async () => {
    const captured = { rows: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[], deleted: false }
    mocks.createServiceClient.mockReturnValue(makeDbTracking(captured))

    await POST(noMatchRequest())

    expect(captured.runUpdates.find(update => update.status === 'failed')).toMatchObject({
      items_total: 2,
      items_matched: 0,
    })
  })
})

// 本番で発生した事故(2026-10-08): 1,935件のCSVを取り込んだとき、商品の照会に
// 全UUIDを一度に .in(...) で渡していたため PostgREST がURL長すぎで400を返し、
// そのエラーを無視していたので「全件が商品に紐付かない」と誤判定した。
// その結果、紐付き904件が未紐付け1,935件で上書きされた。
describe('CSV取込: 商品照会の分割とエラー処理', () => {
  const MANY = Array.from({ length: 250 }, (_, i) => {
    const hex = i.toString(16).padStart(8, '0')
    const uuid = `${hex}-0000-4000-8000-000000000000`
    return { uuid, line: `${1000 + i},kakehashi_${uuid.replace(/-/g, '_')},Item ${i},10.00,1,0` }
  })
  const MANY_CSV = [
    'Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity',
    ...MANY.map((m) => m.line),
  ].join('\n')

  function manyRequest() {
    const form = new FormData()
    form.set('file', new File([MANY_CSV], 'active.csv', { type: 'text/csv' }))
    return new NextRequest('http://localhost/api/inventory/upload?sellerAccountId=seller-a&siteId=US', {
      method: 'POST', body: form,
    })
  }

  function makeDb(options: { idChunkSizes: number[]; failLookup?: boolean; deleted: { value: boolean }; rows: Record<string, unknown>[]; runUpdates: Record<string, unknown>[] }) {
    return {
      from(table: string) {
        if (table === 'seller_accounts') {
          const chain: Record<string, unknown> = {}
          for (const m of ['select', 'eq']) chain[m] = () => chain
          chain.maybeSingle = async () => ({ data: { id: 'seller-a' }, error: null })
          return chain
        }
        if (table === 'inventory_runs') {
          const chain: Record<string, unknown> = {}
          chain.insert = () => chain
          chain.select = () => chain
          chain.single = async () => ({ data: { id: 'run-1' }, error: null })
          chain.update = (payload: Record<string, unknown>) => {
            options.runUpdates.push(payload)
            return { eq: async () => ({ error: null }) }
          }
          return chain
        }
        if (table === 'products') {
          const chain: Record<string, unknown> = {}
          chain.select = () => chain
          chain.eq = () => chain
          chain.in = async (column: string, values: string[]) => {
            if (options.failLookup) return { data: null, error: { message: 'Bad Request' } }
            if (column === 'id') {
              options.idChunkSizes.push(values.length)
              return { data: values.map((id) => ({ id })), error: null }
            }
            return { data: [], error: null }
          }
          chain.update = () => ({ eq: () => ({ in: async () => ({ error: null }) }) })
          return chain
        }
        const chain: Record<string, unknown> = {}
        chain.delete = () => { options.deleted.value = true; return chain }
        chain.eq = () => chain
        chain.upsert = async (rows: Record<string, unknown>[]) => { options.rows.push(...rows); return { error: null } }
        chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
        return chain
      },
    }
  }

  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('商品の照会を100件ずつに分割する（URLが長すぎて400になるのを防ぐ）', async () => {
    const options = { idChunkSizes: [] as number[], deleted: { value: false }, rows: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[] }
    mocks.createServiceClient.mockReturnValue(makeDb(options))

    const res = await POST(manyRequest())
    expect(res.status).toBe(200)

    expect(options.idChunkSizes).toEqual([100, 100, 50])
    expect(options.rows).toHaveLength(250)
  })

  it('照会が失敗したら、既存の在庫管理を消さずに中断する', async () => {
    const options = { idChunkSizes: [] as number[], failLookup: true, deleted: { value: false }, rows: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[] }
    mocks.createServiceClient.mockReturnValue(makeDb(options))

    const res = await POST(manyRequest())
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(options.deleted.value).toBe(false)
    expect(options.rows).toHaveLength(0)
    expect(json.error).toContain('既存の在庫管理は変更していません')
  })
})

// 本番の事故の核心(2026-10-08): ガードが「保存行が0件」だけを条件にしていたため、
// 商品照会が壊れて全件が未紐付けになったとき(保存行は1,935件)にすり抜け、
// 紐付き904件を未紐付け1,935件で上書きしてしまった。
describe('CSV取込: 1件も商品に紐付かない場合', () => {
  const ORPHANS_CSV = [
    'Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity',
    `111,kakehashi_${KNOWN_PRODUCT.replace(/-/g, '_')},Item A,10.00,1,0`,
    `222,kakehashi_${LOST_PRODUCT.replace(/-/g, '_')},Item B,20.00,1,0`,
  ].join('\n')

  function orphansRequest() {
    const form = new FormData()
    form.set('file', new File([ORPHANS_CSV], 'active.csv', { type: 'text/csv' }))
    return new NextRequest('http://localhost/api/inventory/upload?sellerAccountId=seller-a&siteId=US', {
      method: 'POST', body: form,
    })
  }

  function makeDbNoProducts(captured: { deleted: boolean; rows: Record<string, unknown>[]; runUpdates: Record<string, unknown>[] }) {
    return {
      from(table: string) {
        if (table === 'seller_accounts') {
          const chain: Record<string, unknown> = {}
          for (const m of ['select', 'eq']) chain[m] = () => chain
          chain.maybeSingle = async () => ({ data: { id: 'seller-a' }, error: null })
          return chain
        }
        if (table === 'inventory_runs') {
          const chain: Record<string, unknown> = {}
          chain.insert = () => chain
          chain.select = () => chain
          chain.single = async () => ({ data: { id: 'run-1' }, error: null })
          chain.update = (payload: Record<string, unknown>) => {
            captured.runUpdates.push(payload)
            return { eq: async () => ({ error: null }) }
          }
          return chain
        }
        if (table === 'products') {
          const chain: Record<string, unknown> = {}
          chain.select = () => chain
          chain.eq = () => chain
          // 1件も商品が見つからない状態
          chain.in = async () => ({ data: [], error: null })
          chain.update = () => ({ eq: () => ({ in: async () => ({ error: null }) }) })
          return chain
        }
        const chain: Record<string, unknown> = {}
        chain.delete = () => { captured.deleted = true; return chain }
        chain.eq = () => chain
        chain.upsert = async (rows: Record<string, unknown>[]) => { captured.rows.push(...rows); return { error: null } }
        chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
        return chain
      },
    }
  }

  beforeEach(() => {
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.createServiceClient.mockReset()
  })

  it('Kakehashiのラベルが付いていても、商品に1件も紐付かなければ置き換えない', async () => {
    const captured = { deleted: false, rows: [] as Record<string, unknown>[], runUpdates: [] as Record<string, unknown>[] }
    mocks.createServiceClient.mockReturnValue(makeDbNoProducts(captured))

    const res = await POST(orphansRequest())
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(captured.deleted).toBe(false)
    expect(captured.rows).toHaveLength(0)
    expect(json.error).toContain('Kakehashiのラベルが付いた出品は2件ありました')
  })
})
