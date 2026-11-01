import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ユーザーから実際の工程を教わった(2026-11-01)。miyabi-24(US)と akebono-32(UK)に
// 同じ商品を出すと、specifics-in での白抜き・目視削除・AI生成・コンプライアンス
// チェックを2回繰り返している。アカウントで変わるのは透かしだけなので、
// 仕上げたCSVの「アカウントによって変わる列」だけを差し替える。
//
// 複製と変換を分けると「先に複製しておく」順番を意識させることになるので、
// 出品元の抽出から1回の操作で済ませる(ユーザー指示 2026-11-01)。

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), createServiceClient: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createServiceClient }))
vi.mock('@/lib/exchange-rate', () => ({ fetchJpyRate: vi.fn(async () => ({ rate: 190 })) }))
vi.mock('@/lib/inventory-pricing', () => ({
  loadPricingModel: vi.fn(async () => null),
  adjustedJpyRate: (_m: unknown, _c: string, rate: number) => rate,
  sitePriceAdjustment: () => 1,
}))

import { POST } from '@/app/api/extractions/[id]/duplicate/route'

const SOURCE = {
  id: 'ext-1', user_id: 'user-1', source_url: 'https://jp.mercari.com/search?keyword=n64',
  source_site: 'mercari', seller_account_id: 'seller-miyabi', category_id: 'cat-1',
  bulk_edit_setting_id: null, memo: '', is_bulk: true, name: 'Rare Nintendo',
}
const SELLER = { id: 'seller-akebono', seller_id: 'akebono-32', display_name: null }
const SOURCE_PRODUCT = {
  id: 'e421eac7-abb1-493e-bc35-244bcc8fbbe2', user_id: 'user-1', extraction_id: 'ext-1',
  source_url: 'https://jp.mercari.com/item/m73056158207', source_site: 'mercari',
  original_title: 'N64', ebay_price: 404.97, pricing_jpy_per_usd: 150,
  ebay_item_id: '123456789', listing_status: 'listed',
  listed_at: '2026-10-30T00:00:00Z', sold_at: null,
  listing_csv_exported_at: '2026-10-30T12:05:51Z', listing_csv_unlisted_confirmed_at: null,
  created_at: '2026-09-18T00:00:00Z', updated_at: '2026-10-30T00:00:00Z',
}

const HEADER = '"Action(CC=Cp1252)","CustomLabel","StartPrice","Title","Description","Currency","SiteID","PaymentProfileName","ReturnProfileName","ShippingProfileName"'
const CSV = HEADER + '\r\n'
  + '"Add","kakehashi_e421eac7_abb1_493e_bc35_244bcc8fbbe2","404.97","Rare N64","<div>説明, です</div>","USD","US","eBay Payments","US Returns","US Shipping"\r\n'

interface Options {
  /** 複製先セラーが既に持っている商品(仕入先URLで突き合わせる) */
  existing?: Array<Record<string, unknown>>
  insertError?: { message: string }
}

function makeDb(options: Options = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown }> = []
  const db = {
    from(table: string) {
      let columns = ''
      let payload: unknown = null
      const q: Record<string, unknown> = {}
      q.select = (cols?: string) => { columns = cols ?? ''; return q }
      q.eq = () => q
      q.order = () => q
      q.insert = (values: unknown) => { payload = values; calls.push({ table, op: 'insert', payload }); return q }
      q.delete = () => { calls.push({ table, op: 'delete' }); return q }
      q.range = async () => {
        calls.push({ table, op: 'range' })
        return { data: calls.filter(c => c.op === 'range').length === 1 ? [SOURCE_PRODUCT] : [], error: null }
      }
      q.maybeSingle = async () => ({
        data: table === 'extractions' ? SOURCE : SELLER, error: null,
      })
      q.single = async () => ({ data: { id: 'ext-new' }, error: null })
      q.in = () => q
      q.then = (resolve: (v: unknown) => void) => {
        if (payload && options.insertError) return resolve({ data: null, error: options.insertError })
        if (payload) {
          const rows = (payload as Array<Record<string, unknown>>).map((row, index) => ({
            id: `new-${index}`, source_url: row.source_url,
            ebay_price: row.ebay_price, pricing_jpy_per_usd: row.pricing_jpy_per_usd,
          }))
          return resolve({ data: rows, error: null })
        }
        // columns に extractions!inner を含む照会は「複製先が持っている商品」
        if (columns.includes('extractions!inner')) {
          calls.push({ table, op: 'findExisting' })
          return resolve({ data: options.existing ?? [], error: null })
        }
        return resolve({ data: [], error: null })
      }
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
const BASE = {
  sellerAccountId: 'seller-akebono', site: 'UK',
  paymentProfile: 'UK Payments', returnProfile: 'UK Returns', shippingProfile: 'UK Shipping',
}

beforeEach(() => {
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mocks.createServiceClient.mockReset()
})

describe('別セラーへ出品用に変換する', () => {
  it('商品を複製し、仕上げたCSVを変換して返す', async () => {
    const { db, calls } = makeDb()
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ ...BASE, csv: CSV }), { params })
    const json = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, converted: 1, created: 1, reused: 0, currency: 'GBP' })

    // 出品の結果は引き継がず、新しいIDを採番させる
    const inserted = (calls.find(c => c.table === 'products' && c.op === 'insert')?.payload as Array<Record<string, unknown>>)[0]
    expect(inserted).not.toHaveProperty('id')
    expect(inserted.ebay_item_id).toBeNull()
    expect(inserted.listing_status).toBe('draft')
    expect(inserted.original_title).toBe('N64')

    const csv = String(json.csv)
    // 差し替える列
    expect(csv).toContain('"kakehashi_new_0"')
    expect(csv).toContain('"GBP"')
    expect(csv).toContain('"UK"')
    expect(csv).toContain('"UK Payments"')
    // ここが本題。AI生成の結果は作り直さない
    expect(csv).toContain('"Rare N64"')
    expect(csv).toContain('<div>説明, です</div>')
    expect(csv).not.toContain('"kakehashi_e421eac7_abb1_493e_bc35_244bcc8fbbe2"')
  })

  it('同じ操作を繰り返しても商品を二重に作らない', async () => {
    const { db, calls } = makeDb({
      existing: [{
        id: 'already-1', source_url: SOURCE_PRODUCT.source_url,
        ebay_price: 404.97, pricing_jpy_per_usd: 150,
      }],
    })
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ ...BASE, csv: CSV }), { params })
    const json = await res.json() as Record<string, unknown>

    expect(json).toMatchObject({ ok: true, converted: 1, created: 0, reused: 1 })
    // 新しい抽出も商品も作らない
    expect(calls.some(c => c.op === 'insert')).toBe(false)
    expect(String(json.csv)).toContain('"kakehashi_already_1"')
  })

  it('CSVを渡さなければ複製だけ行う', async () => {
    const { db } = makeDb()
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ sellerAccountId: 'seller-akebono' }), { params })
    const json = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, created: 1 })
    expect(json.csv).toBeUndefined()
  })

  it('CSVを渡すのにポリシーが無ければ断る', async () => {
    const { db } = makeDb()
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ sellerAccountId: 'seller-akebono', csv: CSV }), { params })
    expect(res.status).toBe(400)
  })

  it('抽出と同じ出品セラーには出せない', async () => {
    const { db } = makeDb()
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ ...BASE, sellerAccountId: 'seller-miyabi' }), { params })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('同じ出品セラー')
  })

  it('商品の複製に失敗したら、作りかけの抽出ごと片付ける', async () => {
    const { db, calls } = makeDb({ insertError: { message: 'duplicate key' } })
    mocks.createServiceClient.mockReturnValue(db)

    const res = await POST(request({ ...BASE, csv: CSV }), { params })

    expect(res.status).toBe(500)
    expect(calls.filter(c => c.op === 'delete').map(c => c.table)).toEqual(['products', 'extractions'])
  })

  it('ログインしていなければ断る', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(request(BASE), { params })
    expect(res.status).toBe(401)
  })
})
