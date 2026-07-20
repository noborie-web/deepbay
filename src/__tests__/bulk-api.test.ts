import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------- Supabase モック ----------
// resultsByProductId は各テストで差し替える
let mockResultsByProductId: Record<string, { data: unknown[]; error: { message: string } | null }> = {}
let mockDefaultResult: { data: unknown[]; error: { message: string } | null } = { data: [], error: null }

// 同時実行数を追跡するカウンター
let concurrentCount = 0
let maxConcurrentCount = 0
let mockSelectDelay = 0  // ms (0 = 即時)

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      const state = { productId: '' }
      const builder = {
        update: vi.fn(() => builder),
        eq: vi.fn((col: string, val: string) => {
          if (col === 'id') state.productId = val
          return builder
        }),
        select: vi.fn(async () => {
          concurrentCount++
          if (concurrentCount > maxConcurrentCount) maxConcurrentCount = concurrentCount
          if (mockSelectDelay > 0) await new Promise((r) => setTimeout(r, mockSelectDelay))
          const result = mockResultsByProductId[state.productId] ?? mockDefaultResult
          concurrentCount--
          return result
        }),
      }
      return builder
    }),
  })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })),
    },
  })),
}))

// ---------- ヘルパー ----------

async function callBulkPatch(extractionId: string, body: unknown) {
  const { PATCH } = await import('../app/api/products/[extractionId]/bulk/route')
  const req = new NextRequest('http://localhost/api/products/' + extractionId + '/bulk', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
  return PATCH(req, { params: Promise.resolve({ extractionId }) })
}

// ---------- テスト ----------

describe('Bulk API: 入力バリデーション', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockResultsByProductId = {}
    mockDefaultResult = { data: [], error: null }
    concurrentCount = 0
    maxConcurrentCount = 0
    mockSelectDelay = 0
  })

  it('201件の一括更新は400を返す', async () => {
    const updates = Array.from({ length: 201 }, (_, i) => ({ productId: `prod-${i}`, ebay_title: 'Title' }))
    const res = await callBulkPatch('ext-1', { updates })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/200件/)
  })

  it('不正なJSONは400を返す', async () => {
    const { PATCH } = await import('../app/api/products/[extractionId]/bulk/route')
    const req = new NextRequest('http://localhost/api/products/ext-1/bulk', {
      method: 'PATCH',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await PATCH(req, { params: Promise.resolve({ extractionId: 'ext-1' }) })
    expect(res.status).toBe(400)
  })

  it('重複productIdは400を返す', async () => {
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', ebay_title: 'A' }, { productId: 'p1', ebay_title: 'B' }],
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/重複/)
  })

  it('空のupdates配列は400を返す', async () => {
    const res = await callBulkPatch('ext-1', { updates: [] })
    expect(res.status).toBe(400)
  })

  it('null要素は400を返す（{"updates":[null]}）', async () => {
    const res = await callBulkPatch('ext-1', { updates: [null] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/オブジェクト/)
  })

  it('文字列要素は400を返す（{"updates":["test"]}）', async () => {
    const res = await callBulkPatch('ext-1', { updates: ['test'] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/オブジェクト/)
  })

  it('数値要素は400を返す（{"updates":[123]}）', async () => {
    const res = await callBulkPatch('ext-1', { updates: [123] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/オブジェクト/)
  })

  it('配列要素は400を返す（{"updates":[[]]}）', async () => {
    const res = await callBulkPatch('ext-1', { updates: [[]] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/オブジェクト/)
  })
})

describe('Bulk API: フィールドバリデーション', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockResultsByProductId = { p1: { data: [{ id: 'p1' }], error: null } }
    mockDefaultResult = { data: [], error: null }
    concurrentCount = 0
    maxConcurrentCount = 0
    mockSelectDelay = 0
  })

  it('81文字のebay_titleは422で失敗に含まれる', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_title: 'a'.repeat(81) }] })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.failed[0].productId).toBe('p1')
  })

  it('負数のebay_priceは422で失敗に含まれる', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_price: -1 }] })
    expect(res.status).toBe(422)
    expect((await res.json()).failed[0].productId).toBe('p1')
  })

  it('0のebay_priceは422で失敗に含まれる', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_price: 0 }] })
    expect(res.status).toBe(422)
    expect((await res.json()).failed[0].productId).toBe('p1')
  })

  it('文字列のebay_priceは422で失敗に含まれる', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_price: 'abc' }] })
    expect(res.status).toBe(422)
    expect((await res.json()).failed[0].productId).toBe('p1')
  })

  it('nullのebay_priceは許可される（価格クリア）', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_price: null }] })
    expect(res.status).toBe(200)
    expect((await res.json()).succeeded).toContain('p1')
  })

  it('不正なebay_conditionは422で失敗に含まれる', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_condition: 'excellent' }] })
    expect(res.status).toBe(422)
    expect((await res.json()).failed[0].error).toMatch(/ebay_condition/)
  })

  it('Phase2フィールド(ebay_description)はホワイトリストで除外され、有効フィールドなしで失敗', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_description: 'test' }] })
    expect(res.status).toBe(422)
    expect((await res.json()).failed[0].error).toMatch(/フィールド/)
  })
})

describe('Bulk API: DB更新結果', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockResultsByProductId = {}
    mockDefaultResult = { data: [], error: null }
    concurrentCount = 0
    maxConcurrentCount = 0
    mockSelectDelay = 0
  })

  it('更新対象0件（他ユーザーの商品）は失敗として返される', async () => {
    mockDefaultResult = { data: [], error: null }  // 0行更新
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', ebay_title: 'Valid Title' }] })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.failed[0].productId).toBe('p1')
    expect(json.failed[0].error).toMatch(/存在しない|権限/)
  })

  it('全件成功の場合は200とsucceeded[]を返す', async () => {
    mockResultsByProductId = {
      p1: { data: [{ id: 'p1' }], error: null },
      p2: { data: [{ id: 'p2' }], error: null },
    }
    const res = await callBulkPatch('ext-1', {
      updates: [
        { productId: 'p1', ebay_title: 'Title 1' },
        { productId: 'p2', ebay_title: 'Title 2' },
      ],
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.succeeded).toContain('p1')
    expect(json.succeeded).toContain('p2')
    expect(json.failed).toHaveLength(0)
  })

  it('部分失敗は422とsucceeded/failed両方を返す（productIdで判定）', async () => {
    mockResultsByProductId = {
      p1: { data: [{ id: 'p1' }], error: null },
      p2: { data: [], error: null },  // p2 は0件更新
    }
    const res = await callBulkPatch('ext-1', {
      updates: [
        { productId: 'p1', ebay_title: 'Title 1' },
        { productId: 'p2', ebay_title: 'Title 2' },
      ],
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.succeeded).toContain('p1')
    expect(json.failed.map((f: { productId: string }) => f.productId)).toContain('p2')
  })
})

describe('Bulk API: 同時実行数制限', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockResultsByProductId = {}
    mockDefaultResult = { data: [{ id: 'x' }], error: null }
    concurrentCount = 0
    maxConcurrentCount = 0
    mockSelectDelay = 5  // 5ms の遅延で並行性を計測
  })

  it('25件の更新でも同時実行は最大10件以下', async () => {
    const updates = Array.from({ length: 25 }, (_, i) => ({
      productId: `prod-${i}`,
      ebay_title: `Title ${i}`,
    }))
    // 全productIdを成功にセット
    for (const u of updates) {
      mockResultsByProductId[u.productId] = { data: [{ id: u.productId }], error: null }
    }

    const res = await callBulkPatch('ext-1', { updates })
    expect(res.status).toBe(200)
    expect(maxConcurrentCount).toBeLessThanOrEqual(10)
    expect(maxConcurrentCount).toBeGreaterThan(0)
  })
})

describe('Bulk API: ホワイトリスト', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockResultsByProductId = { p1: { data: [{ id: 'p1' }], error: null } }
    mockDefaultResult = { data: [], error: null }
    concurrentCount = 0
    maxConcurrentCount = 0
    mockSelectDelay = 0
  })

  it('original_priceを除外しても有効フィールドがあれば成功する', async () => {
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', original_price: 99999, ebay_title: 'Valid' }],
    })
    expect(res.status).toBe(200)
  })

  it('purchase_price_jpyは保存できる', async () => {
    const res = await callBulkPatch('ext-1', { updates: [{ productId: 'p1', purchase_price_jpy: 3000 }] })
    expect(res.status).toBe(200)
    expect((await res.json()).succeeded).toContain('p1')
  })
})

describe('新規抽出時のebay_price', () => {
  it('extract/route.ts は ebay_price を null にセットする', async () => {
    // 抽出ルートの実装を検証：ebay_price は scraped.price ではなく null
    const { readFileSync } = await import('fs')
    const src = readFileSync('src/app/api/extract/route.ts', 'utf8')
    // 正しい実装: null を代入
    expect(src).toMatch(/const ebayPrice\s*:\s*number \| null\s*=\s*null/)
    // 誤った実装(scraped.price の使用)がないこと
    expect(src).not.toMatch(/ebayPrice\s*=\s*scraped\.price/)
  })
})
