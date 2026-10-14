import { describe, expect, it, vi } from 'vitest'
import {
  AmazonSearchError,
  MAX_KEYWORDS,
  parseAmazonSearchQuery,
  searchAmazonAsins,
} from '@/lib/amazon-search'

// ユーザー要望(2026-10-12): 仕入先としてのAmazon、段階2。
// Amazonの検索URL・キーワードからASIN一覧を作る。

describe('parseAmazonSearchQuery', () => {
  it('検索URLからキーワードとカテゴリを読み取る', () => {
    const q = parseAmazonSearchQuery('https://www.amazon.co.jp/s?k=casio+watch&node=2017157051')
    expect(q.keywords).toEqual(['casio', 'watch'])
    expect(q.classificationIds).toEqual(['2017157051'])
    expect(q.brandNames).toEqual([])
    expect(q.warnings).toEqual([])
  })

  it('rh のカテゴリ(n:)とブランド(p_89:)を読み取る', () => {
    const q = parseAmazonSearchQuery(
      'https://www.amazon.co.jp/s?k=%E8%85%95%E6%99%82%E8%A8%88&rh=n%3A2017157051%7C2128056051%2Cp_89%3ACASIO%7CSEIKO',
    )
    expect(q.keywords).toEqual(['腕時計'])
    expect(q.classificationIds).toEqual(['2017157051', '2128056051'])
    expect(q.brandNames).toEqual(['CASIO', 'SEIKO'])
  })

  it('URLでなければ全体をキーワードとして扱う', () => {
    expect(parseAmazonSearchQuery('casio 腕時計, デジタル').keywords).toEqual(['casio', '腕時計', 'デジタル'])
  })

  it('キーワードは重複を除いて20語までにする(SP-APIの上限)', () => {
    const input = Array.from({ length: 30 }, (_, i) => `w${i}`).concat('w0').join(' ')
    const q = parseAmazonSearchQuery(input)
    expect(q.keywords).toHaveLength(MAX_KEYWORDS)
    expect(new Set(q.keywords).size).toBe(MAX_KEYWORDS)
  })

  // SP-APIの検索はキーワードが必須で、カテゴリ・ブランドは「キーワード検索の
  // 絞り込み」にしかならない。URLにカテゴリだけ入っていても検索できないので、
  // 黙って0件にせず理由を伝える。
  it('カテゴリだけのURLでは検索できないことを警告する', () => {
    const q = parseAmazonSearchQuery('https://www.amazon.co.jp/s?node=2017157051')
    expect(q.keywords).toEqual([])
    expect(q.classificationIds).toEqual(['2017157051'])
    expect(q.warnings.join()).toContain('キーワード')
  })

  it('SP-APIに対応しない絞り込み(i=)は無視して警告する', () => {
    const q = parseAmazonSearchQuery('https://www.amazon.co.jp/s?k=watch&i=electronics')
    expect(q.keywords).toEqual(['watch'])
    expect(q.warnings.join()).toContain('i=electronics')
  })

  // URLそのものを1語のキーワードとして検索しても意味が無い
  it('amazon以外のURLはキーワード扱いにせず理由を返す', () => {
    const q = parseAmazonSearchQuery('https://example.com/s?k=watch')
    expect(q.keywords).toEqual([])
    expect(q.warnings.join()).toContain('Amazon.co.jp')
  })
})

describe('searchAmazonAsins', () => {
  const query = { keywords: ['casio'], brandNames: [], classificationIds: [], warnings: [] }

  function page(asins: string[], nextToken?: string) {
    return {
      ok: true,
      headers: new Headers({ 'x-amzn-RateLimit-Limit': '2.0' }),
      json: async () => ({
        items: asins.map(asin => ({
          asin,
          summaries: [{ marketplaceId: 'A1VC38T7YXB528', itemName: `${asin} の商品`, brand: 'CASIO' }],
        })),
        pagination: nextToken ? { nextToken } : {},
      }),
    } as unknown as Response
  }

  it('キーワードが無ければ呼ばずに弾く', async () => {
    await expect(
      searchAmazonAsins('token', { keywords: [], brandNames: [], classificationIds: [], warnings: [] }),
    ).rejects.toBeInstanceOf(AmazonSearchError)
  })

  it('pageTokenで続きを取り、limitで打ち切る', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(['B000000001', 'B000000002'], 'token-2'))
      .mockResolvedValueOnce(page(['B000000003', 'B000000004'], 'token-3'))
    vi.stubGlobal('fetch', fetchMock)
    const sleep = vi.fn(async () => {})

    const result = await searchAmazonAsins('token', query, { limit: 3, sleep })

    expect(result.items.map(i => i.asin)).toEqual(['B000000001', 'B000000002', 'B000000003'])
    expect(result.truncated).toBe(true)
    expect(result.requests).toBe(2)
    // 2ページ目のURLには pageToken が入る
    expect(String(fetchMock.mock.calls[1][0])).toContain('pageToken=token-2')
    // レート制限に当てないよう、ページの間で待つ(2 req/s = 500ms)
    expect(sleep).toHaveBeenCalledWith(500)
    vi.unstubAllGlobals()
  })

  it('続きが無ければ打ち切らずに終わる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(['B000000001'])))
    const result = await searchAmazonAsins('token', query, { limit: 100, sleep: async () => {} })
    expect(result.items).toEqual([{ asin: 'B000000001', title: 'B000000001 の商品', brand: 'CASIO' }])
    expect(result.truncated).toBe(false)
    vi.unstubAllGlobals()
  })

  it('カテゴリ・ブランドの絞り込みをリクエストに載せる', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page(['B000000001']))
    vi.stubGlobal('fetch', fetchMock)
    await searchAmazonAsins('token', {
      keywords: ['watch'], brandNames: ['CASIO'], classificationIds: ['2017157051'], warnings: [],
    }, { sleep: async () => {} })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('keywords=watch')
    expect(url).toContain('brandNames=CASIO')
    expect(url).toContain('classificationIds=2017157051')
    expect(url).toContain('pageSize=20')
    vi.unstubAllGlobals()
  })

  it('同じASINが複数ページに出ても重複させない', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(page(['B000000001', 'B000000002'], 'token-2'))
      .mockResolvedValueOnce(page(['B000000002', 'B000000003'])))
    const result = await searchAmazonAsins('token', query, { limit: 100, sleep: async () => {} })
    expect(result.items.map(i => i.asin)).toEqual(['B000000001', 'B000000002', 'B000000003'])
    vi.unstubAllGlobals()
  })

  // 既存ツールの教訓(2026-07-18): 失敗を空の結果として確定させると、
  // 「0件だった」のか「取れなかった」のか区別できなくなる。
  it('1ページ目が失敗したらエラーにする(0件として返さない)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      headers: new Headers(),
      json: async () => ({ errors: [{ message: 'Invalid keywords' }] }),
    } as unknown as Response))
    await expect(searchAmazonAsins('token', query, { sleep: async () => {} }))
      .rejects.toThrow('Invalid keywords')
    vi.unstubAllGlobals()
  })

  it('途中のページが失敗したら、取れた分と「続きがある」を返す', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(page(['B000000001'], 'token-2'))
      .mockResolvedValueOnce({
        ok: false, headers: new Headers(), json: async () => ({ errors: [{ message: 'QuotaExceeded' }] }),
      } as unknown as Response))
    const result = await searchAmazonAsins('token', query, { limit: 100, sleep: async () => {} })
    expect(result.items.map(i => i.asin)).toEqual(['B000000001'])
    expect(result.truncated).toBe(true)
    vi.unstubAllGlobals()
  })

  it('応答ヘッダのレート制限に合わせて待つ', async () => {
    const slowPage = {
      ok: true,
      headers: new Headers({ 'x-amzn-RateLimit-Limit': '0.5' }),
      json: async () => ({ items: [{ asin: 'B000000001', summaries: [] }], pagination: { nextToken: 't2' } }),
    } as unknown as Response
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(slowPage)
      .mockResolvedValueOnce(page(['B000000002'])))
    const sleep = vi.fn(async () => {})
    await searchAmazonAsins('token', query, { limit: 100, sleep })
    expect(sleep).toHaveBeenCalledWith(2000)
    vi.unstubAllGlobals()
  })
})
