import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCategoryAspects, getCategoryItemSpecificsNames } from '@/lib/ebay-taxonomy'

const originalEnv = { ...process.env }

describe('fetchCategoryAspects', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.EBAY_CLIENT_ID = 'client-id'
    process.env.EBAY_CLIENT_SECRET = 'client-secret'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...originalEnv }
  })

  // ユーザー要望: 音楽CD等のカテゴリでは公式ツールのようにArtist・
  // Record Label等の項目を出力したいが、Kakehashiはゲーム向けの固定
  // リストしか出力していなかった。eBay Taxonomy APIから実際の項目名を
  // 取得できるようにする。
  it('必須項目を先頭にして、カテゴリの実際の項目名一覧を返す', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/identity/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 })
      }
      if (url.includes('get_item_aspects_for_category')) {
        return new Response(JSON.stringify({
          aspects: [
            { localizedAspectName: 'Genre', aspectConstraint: { aspectRequired: false } },
            { localizedAspectName: 'Artist', aspectConstraint: { aspectRequired: true } },
            { localizedAspectName: 'Record Label', aspectConstraint: { aspectRequired: false } },
          ],
        }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    const aspects = await fetchCategoryAspects('176984')

    expect(aspects).toEqual([
      { name: 'Artist', required: true },
      { name: 'Genre', required: false },
      { name: 'Record Label', required: false },
    ])
  })

  it('認証情報が未設定の場合はエラーを投げる', async () => {
    delete process.env.EBAY_CLIENT_ID
    await expect(fetchCategoryAspects('176984')).rejects.toThrow()
  })

  it('Taxonomy APIがエラーを返した場合はエラーを投げる', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/identity/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 })
      }
      return new Response('server error', { status: 500 })
    }) as unknown as typeof fetch

    await expect(fetchCategoryAspects('176984')).rejects.toThrow()
  })
})

describe('getCategoryItemSpecificsNames', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.EBAY_CLIENT_ID = 'client-id'
    process.env.EBAY_CLIENT_SECRET = 'client-secret'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...originalEnv }
  })

  function makeClient(options: {
    cached?: { aspect_names: unknown; fetched_at: string } | null
  } = {}) {
    const upserts: Record<string, unknown>[] = []
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: options.cached ?? null }),
          }),
        }),
        upsert: async (payload: Record<string, unknown>) => {
          upserts.push(payload)
          return { data: null, error: null }
        },
      }),
    }
    return { client, upserts }
  }

  it('新しいキャッシュがあればAPIを呼ばずキャッシュの項目名を返す', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { client } = makeClient({
      cached: { aspect_names: ['Artist', 'Record Label'], fetched_at: new Date().toISOString() },
    })

    const names = await getCategoryItemSpecificsNames('176984', client)

    expect(names).toEqual(['Artist', 'Record Label'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('キャッシュが無い場合はAPIから取得してキャッシュに保存する', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/identity/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 })
      }
      if (url.includes('get_item_aspects_for_category')) {
        return new Response(JSON.stringify({
          aspects: [{ localizedAspectName: 'Artist', aspectConstraint: { aspectRequired: true } }],
        }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    const { client, upserts } = makeClient({ cached: null })

    const names = await getCategoryItemSpecificsNames('176984', client)

    expect(names).toEqual(['Artist'])
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ category_id: '176984', aspect_names: ['Artist'] })
  })

  it('30日より古いキャッシュは無視して再取得する', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/identity/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 })
      }
      return new Response(JSON.stringify({
        aspects: [{ localizedAspectName: 'Genre', aspectConstraint: { aspectRequired: false } }],
      }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    const { client } = makeClient({ cached: { aspect_names: ['Old'], fetched_at: staleDate } })

    const names = await getCategoryItemSpecificsNames('176984', client)

    expect(names).toEqual(['Genre'])
    expect(fetchMock).toHaveBeenCalled()
  })

  it('取得に失敗した場合はnullを返す(呼び出し側が固定リストにフォールバックできるように)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network error')
    }) as unknown as typeof fetch
    const { client } = makeClient({ cached: null })

    const names = await getCategoryItemSpecificsNames('176984', client)

    expect(names).toBeNull()
  })
})
