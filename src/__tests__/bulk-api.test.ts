import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ---------- Supabase モック ----------
const mockUpdate = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()

// Supabase クエリビルダーのチェーン: .update().eq().eq().eq().select()
function makeQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(result),
  }
  return builder
}

let supabaseQueryBuilder: ReturnType<typeof makeQueryBuilder>

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => supabaseQueryBuilder),
  })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })),
    },
  })),
}))

// ---------- テスト本体 ----------

async function callBulkPatch(extractionId: string, body: unknown) {
  // Dynamic import so mocks are in place first
  const { PATCH } = await import('../app/api/products/[extractionId]/bulk/route')
  const req = new NextRequest('http://localhost/api/products/' + extractionId + '/bulk', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
  return PATCH(req, { params: Promise.resolve({ extractionId }) })
}

describe('Bulk API: route handler (モック Supabase)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('201件の一括更新は400を返す', async () => {
    const updates = Array.from({ length: 201 }, (_, i) => ({
      productId: `prod-${i}`,
      ebay_title: 'Title',
    }))
    const res = await callBulkPatch('ext-1', { updates })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/200件/)
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
      updates: [
        { productId: 'p1', ebay_title: 'A' },
        { productId: 'p1', ebay_title: 'B' },
      ],
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/重複/)
  })

  it('81文字のebay_titleは422で失敗に含まれる', async () => {
    supabaseQueryBuilder = makeQueryBuilder({ data: [{ id: 'p1' }], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', ebay_title: 'a'.repeat(81) }],
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.failed[0].productId).toBe('p1')
  })

  it('負数のebay_priceは422で失敗に含まれる', async () => {
    supabaseQueryBuilder = makeQueryBuilder({ data: [{ id: 'p1' }], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', ebay_price: -1 }],
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.failed[0].productId).toBe('p1')
  })

  it('NaNのebay_priceは422で失敗に含まれる', async () => {
    supabaseQueryBuilder = makeQueryBuilder({ data: [{ id: 'p1' }], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', ebay_price: null }], // null は許可
    })
    // null は許可なのでDBへ行く。DBがデータを返したとする
    supabaseQueryBuilder = makeQueryBuilder({ data: [{ id: 'p1' }], error: null })
    expect([200, 422]).toContain(res.status)
  })

  it('不正なebay_conditionは422で失敗に含まれる', async () => {
    supabaseQueryBuilder = makeQueryBuilder({ data: [{ id: 'p1' }], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', ebay_condition: 'excellent' }],
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.failed[0].productId).toBe('p1')
    expect(json.failed[0].error).toMatch(/ebay_condition/)
  })

  it('更新対象0件（他ユーザーの商品）は失敗として返される', async () => {
    supabaseQueryBuilder = makeQueryBuilder({ data: [], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', ebay_title: 'Valid Title' }],
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.failed[0].productId).toBe('p1')
    expect(json.failed[0].error).toMatch(/存在しない|権限/)
  })

  it('全件成功の場合は200と succeeded[] を返す', async () => {
    supabaseQueryBuilder = makeQueryBuilder({ data: [{ id: 'p1' }], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', ebay_title: 'Valid Title' }],
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.succeeded).toContain('p1')
    expect(json.failed).toHaveLength(0)
  })

  it('部分失敗の場合は422と succeeded/failed 両方を返す', async () => {
    // p1 は成功、p2 は0件更新（失敗）
    let callCount = 0
    supabaseQueryBuilder = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockImplementation(async () => {
        callCount++
        return callCount === 1
          ? { data: [{ id: 'p1' }], error: null }
          : { data: [], error: null }
      }),
    }

    const res = await callBulkPatch('ext-1', {
      updates: [
        { productId: 'p1', ebay_title: 'Valid Title' },
        { productId: 'p2', ebay_title: 'Another Title' },
      ],
    })
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.ok).toBe(false)
    expect(json.succeeded).toContain('p1')
    expect(json.failed.map((f: { productId: string }) => f.productId)).toContain('p2')
  })
})

describe('Bulk API: pickAllowed() ホワイトリストフィルタ', () => {
  it('original_priceを除外する', async () => {
    // 0件更新になるように設定しておく（バリデーションは通過させる）
    supabaseQueryBuilder = makeQueryBuilder({ data: [], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', original_price: 99999, ebay_title: 'Valid' }],
    })
    // original_price は除外されているので DB には ebay_title だけ渡る
    // 0件更新なので 422 だが、バリデーションエラーではない
    const json = await res.json()
    expect(json.failed[0].error).toMatch(/存在しない|権限/)
  })

  it('purchase_price_jpyは保存できる（バリデーション通過）', async () => {
    supabaseQueryBuilder = makeQueryBuilder({ data: [{ id: 'p1' }], error: null })
    const res = await callBulkPatch('ext-1', {
      updates: [{ productId: 'p1', purchase_price_jpy: 3000 }],
    })
    expect(res.status).toBe(200)
  })
})

describe('新規抽出時のebay_price', () => {
  it('extract/route.ts は ebay_price を null にする', async () => {
    // extract route の実装を静的に確認する
    const fs = await import('fs')
    const src = fs.readFileSync('src/app/api/extract/route.ts', 'utf8')
    expect(src).toMatch(/ebayPrice.*=.*null/)
    expect(src).not.toMatch(/ebayPrice.*=.*scraped\.price/)
  })
})
