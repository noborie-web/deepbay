import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザー要望(2026-11-01): miyabi-24(US)に出した商品を akebono-32(UK)にも出して
// 時間を短縮したい。商品を別セラーの抽出として複製すれば、既存のCSV出力
// (sites=UK)がそのまま使える。複製で商品IDが変わるので CustomLabel も別になり、
// 出品ごとに在庫管理が効く(同じ商品IDのまま2アカウントに出すと
// products.ebay_item_id と listing_status が単一値のため上書きされる)。

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))

import { POST } from '@/app/api/extractions/[id]/duplicate/route'

const SOURCE = {
  id: 'ext-1', user_id: 'user-1', source_url: 'https://jp.mercari.com/search?keyword=n64',
  source_site: 'mercari', seller_account_id: 'seller-miyabi', category_id: 'cat-1',
  bulk_edit_setting_id: null, memo: 'メモ', is_bulk: true, name: 'Rare Nintendo',
}
const SELLER = { id: 'seller-akebono', seller_id: 'akebono-32', display_name: null }

interface Options {
  source?: Record<string, unknown> | null
  seller?: Record<string, unknown> | null
  products?: Array<Record<string, unknown>>
  insertError?: { message: string }
}

function makeDb(options: Options = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown }> = []
  const products = options.products ?? [{
    id: 'p1', user_id: 'user-1', extraction_id: 'ext-1', source_url: 'https://jp.mercari.com/item/m1',
    source_site: 'mercari', original_title: 'N64', ebay_price: 404.97,
    ebay_item_id: '123456789', listing_status: 'listed',
    listed_at: '2026-10-30T00:00:00Z', sold_at: null,
    listing_csv_exported_at: '2026-10-30T12:05:51Z', listing_csv_unlisted_confirmed_at: null,
    created_at: '2026-09-18T00:00:00Z', updated_at: '2026-10-30T00:00:00Z',
  }]
  const db = {
    from(table: string) {
      let payload: unknown = null
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.eq = () => q
      q.order = () => q
      q.insert = (values: unknown) => { payload = values; calls.push({ table, op: 'insert', payload }); return q }
      q.delete = () => { calls.push({ table, op: 'delete' }); return q }
      q.range = async () => {
        if (table !== 'products') return { data: [], error: null }
        calls.push({ table, op: 'range' })
        return { data: calls.filter(c => c.op === 'range').length === 1 ? products : [], error: null }
      }
      q.maybeSingle = async () => ({
        data: table === 'extractions'
          ? (options.source === undefined ? SOURCE : options.source)
          : (options.seller === undefined ? SELLER : options.seller),
        error: null,
      })
      q.single = async () => ({ data: { id: 'ext-new' }, error: null })
      q.then = (resolve: (v: unknown) => void) => resolve(
        table === 'products' && payload && options.insertError
          ? { data: null, error: options.insertError }
          : { data: [{ id: 'new-1' }], error: null },
      )
      return q
    },
  }
  return { db, calls }
}

function request(body: unknown) {
  return new NextRequest('http://localhost/api/extractions/ext-1/duplicate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: 'ext-1' })

beforeEach(() => {
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mocks.createServiceClient.mockReset()
})

describe('抽出を別セラーへ複製する', () => {
  it('複製先の抽出を作り、商品を新しいIDで入れ直す', async () => {
    const { db, calls } = makeDb()
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ sellerAccountId: 'seller-akebono' }), { params })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, extraction_id: 'ext-new', seller_id: 'akebono-32' })

    const createdExtraction = calls.find(c => c.table === 'extractions' && c.op === 'insert')?.payload as Record<string, unknown>
    expect(createdExtraction.seller_account_id).toBe('seller-akebono')
    // 抽出そのものは実行しないので、完了として作る
    expect(createdExtraction.status).toBe('completed')
    expect(createdExtraction.name).toBe('Rare Nintendo（akebono-32）')

    const inserted = (calls.find(c => c.table === 'products' && c.op === 'insert')?.payload as Array<Record<string, unknown>>)[0]
    // 新しいIDを採番させる(ここが本題。CustomLabel が別物になる)
    expect(inserted).not.toHaveProperty('id')
    expect(inserted).not.toHaveProperty('created_at')
    expect(inserted.extraction_id).toBe('ext-new')
    // 出品の結果は引き継がない
    expect(inserted.ebay_item_id).toBeNull()
    expect(inserted.listing_status).toBe('draft')
    expect(inserted.listed_at).toBeNull()
    expect(inserted.listing_csv_exported_at).toBeNull()
    // 商品の中身は同じものを出すので引き継ぐ
    expect(inserted.original_title).toBe('N64')
    expect(inserted.ebay_price).toBe(404.97)
    expect(inserted.source_url).toBe('https://jp.mercari.com/item/m1')
  })

  it('同じ出品セラーには複製しない', async () => {
    const { db } = makeDb()
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ sellerAccountId: 'seller-miyabi' }), { params })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('同じ出品セラー')
  })

  it('出品セラーの指定が無ければ断る', async () => {
    const { db } = makeDb()
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({}), { params })
    expect(res.status).toBe(400)
  })

  it('商品が無い抽出は複製しない', async () => {
    const { db } = makeDb({ products: [] })
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ sellerAccountId: 'seller-akebono' }), { params })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('商品がありません')
  })

  it('商品の複製に失敗したら、作りかけの抽出ごと片付ける', async () => {
    const { db, calls } = makeDb({ insertError: { message: 'duplicate key' } })
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ sellerAccountId: 'seller-akebono' }), { params })

    expect(res.status).toBe(500)
    // 中途半端な抽出を残さない
    expect(calls.filter(c => c.op === 'delete').map(c => c.table)).toEqual(['products', 'extractions'])
  })

  it('ログインしていなければ断る', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(request({ sellerAccountId: 'seller-akebono' }), { params })
    expect(res.status).toBe(401)
  })
})
