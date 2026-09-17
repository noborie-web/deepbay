import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { checkTranslatedDescription, hasJapaneseDescription } from '@/lib/description-translation'

// ユーザー要望: 出品済み商品の日本語の説明文を英訳し、eBayの説明文を差し替える。
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  translateDescription: vi.fn(),
  reviseDescription: vi.fn(),
  resolveAccessToken: vi.fn(),
}))

let mockProducts: Array<Record<string, unknown>> = []
const productUpdates: Array<Record<string, unknown>> = []
const runInserts: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self, eq: self, in: self, not: self,
        order: async () => ({ data: table === 'products' ? mockProducts : [], error: null }),
        maybeSingle: async () => ({ data: table === 'extraction_settings' ? { description_engine: 'high' } : { ebay_token: 't' }, error: null }),
        update: (payload: Record<string, unknown>) => {
          productUpdates.push(payload)
          return { eq: () => ({ eq: async () => ({ error: null }) }) }
        },
        insert: async (payload: Record<string, unknown>) => { runInserts.push(payload); return { error: null } },
      })
      return chain
    },
  })),
}))
vi.mock('@/lib/translate', () => ({ translateDescription: mocks.translateDescription }))
vi.mock('@/lib/ebay-actions', () => ({ reviseDescription: mocks.reviseDescription }))
vi.mock('@/lib/inventory-auth', () => ({ resolveInventoryAccessToken: mocks.resolveAccessToken }))
vi.mock('@/lib/html-template', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/html-template')>()),
  loadActiveHtmlTemplate: vi.fn(async () => null),
}))

import { POST } from '@/app/api/inventory/actions/translate-descriptions/route'

const request = (body: unknown) => new NextRequest('http://localhost/api/inventory/actions/translate-descriptions', {
  method: 'POST', body: JSON.stringify(body),
})

describe('hasJapaneseDescription', () => {
  it('日本語が主体なら未翻訳とみなす', () => {
    expect(hasJapaneseDescription({ ebay_description: '新品未開封です', original_description: null })).toBe(true)
    expect(hasJapaneseDescription({ ebay_description: 'Brand new, sealed.', original_description: '新品' })).toBe(false)
    expect(hasJapaneseDescription({ ebay_description: null, original_description: 'ゆうパックで発送' })).toBe(true)
  })

  it('曲名など一部に日本語が残る翻訳済みの説明文は未翻訳とみなさない', () => {
    // 本番で確認した不具合: 曲名を日本語で残した正しい翻訳が7件「失敗」になった
    const translated = 'Limited edition album "Memai (眩暈～めまい～)" by Laputa, signed by all members on the case. Minor scuffs on case and disc. Tracklist includes "Gekka no Yasoukyoku (月下の夜想曲)".'
    expect(hasJapaneseDescription({ ebay_description: translated, original_description: '限定盤' })).toBe(false)
  })
})

describe('checkTranslatedDescription', () => {
  it('日本語の割合が小さく禁止語が無ければ成功', () => {
    expect(checkTranslatedDescription('Rare CD "Ware Omou Toki Ai (我想う時愛)" by S.L.A.C.K. Out of print. Excellent condition.')).toEqual({ ok: true })
  })
  it('国内向けの文言が残っていれば失敗', () => {
    expect(checkTranslatedDescription('Ships via ゆうパック. Sealed.').ok).toBe(false)
    expect(checkTranslatedDescription('Rare CD. 即購入OK').ok).toBe(false)
  })
  it('日本語が多く残っていれば失敗', () => {
    expect(checkTranslatedDescription('新品未開封のCDです。目立つ傷はありません。Sealed.').ok).toBe(false)
  })
})

describe('POST /api/inventory/actions/translate-descriptions', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test'
    mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } } })
    mocks.translateDescription.mockReset().mockResolvedValue('Brand new, sealed. Ships from Japan.')
    mocks.reviseDescription.mockReset().mockResolvedValue({ itemId: '1', success: true })
    mocks.resolveAccessToken.mockReset().mockResolvedValue('access-token')
    productUpdates.length = 0
    runInserts.length = 0
    mockProducts = [
      { id: 'p-ja', ebay_item_id: '1', ebay_title: 'A', original_title: 'A', ebay_description: '新品未開封。ゆうパックで発送します。', original_description: '新品未開封。ゆうパックで発送します。', ebay_condition: 'New', original_condition: null, listing_status: 'listed', description_synced_at: null },
      { id: 'p-en', ebay_item_id: '2', ebay_title: 'B', original_title: 'B', ebay_description: 'Used, good condition.', original_description: '中古', ebay_condition: 'Used', original_condition: null, listing_status: 'listed', description_synced_at: null },
      { id: 'p-done', ebay_item_id: '3', ebay_title: 'C', original_title: 'C', ebay_description: 'Sealed.', original_description: '新品', ebay_condition: 'New', original_condition: null, listing_status: 'listed', description_synced_at: '2026-09-17T00:00:00Z' },
    ]
  })

  it('status: 未翻訳・翻訳済み・eBay未反映の件数を返す', async () => {
    const res = await POST(request({ mode: 'status' }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toEqual({ total: 3, untranslated: 1, translated: 2, unsynced: 1 })
  })

  it('preview: 未翻訳の商品を翻訳して before/after を返し、保存はしない', async () => {
    const res = await POST(request({ mode: 'preview', limit: 3 }))
    const json = await res.json()
    expect(json.samples).toHaveLength(1)
    expect(json.samples[0]).toMatchObject({ id: 'p-ja', before: '新品未開封。ゆうパックで発送します。', after: 'Brand new, sealed. Ships from Japan.' })
    expect(productUpdates).toHaveLength(0)
  })

  it('translate: 元の説明文(original_description)を翻訳して ebay_description に保存し、eBay未反映にする', async () => {
    const res = await POST(request({ mode: 'translate' }))
    const json = await res.json()
    expect(json).toMatchObject({ translated: 1, failed: [], remaining: 0, done: true })
    expect(mocks.translateDescription).toHaveBeenCalledWith('新品未開封。ゆうパックで発送します。', 'high')
    expect(productUpdates[0]).toMatchObject({ ebay_description: 'Brand new, sealed. Ships from Japan.', description_synced_at: null })
  })

  it('translate: 翻訳結果に国内向けの文言が残っていれば失敗扱いにして保存しない', async () => {
    mocks.translateDescription.mockResolvedValue('Brand new. Ships via ゆうパック')
    const json = await (await POST(request({ mode: 'translate' }))).json()
    expect(json.translated).toBe(0)
    expect(json.failed).toHaveLength(1)
    expect(productUpdates).toHaveLength(0)
  })

  it('revise: 翻訳済み・未反映・出品中の商品だけ ReviseItem で説明文(HTML)を差し替え、反映日時を記録してログを残す', async () => {
    const res = await POST(request({ mode: 'revise' }))
    const json = await res.json()
    expect(json).toMatchObject({ revised: 1, failed: [], remaining: 0, done: true })
    expect(mocks.reviseDescription).toHaveBeenCalledTimes(1)
    const [token, itemId, html] = mocks.reviseDescription.mock.calls[0]
    expect(token).toBe('access-token')
    expect(itemId).toBe('2')
    expect(html).toContain('Used, good condition.')
    expect(html).toContain('<h2>Description</h2>')
    expect(productUpdates[0]).toMatchObject({ description_synced_at: expect.any(String) })
    expect(runInserts[0]).toMatchObject({ run_type: 'revise_description', status: 'completed' })
  })
})
