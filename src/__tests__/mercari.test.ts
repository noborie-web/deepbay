import { describe, it, expect } from 'vitest'
import {
  _extractImages,
  _generateDPoP,
  _getDPoPContext,
  _getMultiNumberParam,
  _toProduct,
  MercariScraper,
} from '../lib/scrapers/mercari'

describe('DPoP JWT generation', () => {
  it('produces a 3-segment JWT string', async () => {
    const ctx = await _getDPoPContext()
    const token = await _generateDPoP('https://api.mercari.jp/v2/entities:search', 'POST', ctx)
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
  })

  it('header segment decodes to ES256 dpop+jwt', async () => {
    const ctx = await _getDPoPContext()
    const token = await _generateDPoP('https://api.mercari.jp/v2/entities:search', 'POST', ctx)
    const headerJson = Buffer.from(token.split('.')[0], 'base64url').toString('utf8')
    const header = JSON.parse(headerJson)
    expect(header.alg).toBe('ES256')
    expect(header.typ).toBe('dpop+jwt')
    expect(header.jwk).toBeDefined()
    expect(header.jwk.crv).toBe('P-256')
  })

  it('payload contains htm, htu, iat, jti, uuid', async () => {
    const ctx = await _getDPoPContext()
    const htu = 'https://api.mercari.jp/v2/entities:search'
    const token = await _generateDPoP(htu, 'POST', ctx)
    const payloadJson = Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    const payload = JSON.parse(payloadJson)
    expect(payload.htm).toBe('POST')
    expect(payload.htu).toBe(htu)
    expect(typeof payload.iat).toBe('number')
    expect(typeof payload.jti).toBe('string')
    expect(typeof payload.uuid).toBe('string')
  })

  it('getDPoPContext reuses the same key pair (singleton)', async () => {
    const a = await _getDPoPContext()
    const b = await _getDPoPContext()
    expect(a).toBe(b)
  })

  it('signature is 64 bytes (R||S for ES256)', async () => {
    const ctx = await _getDPoPContext()
    const token = await _generateDPoP('https://api.mercari.jp/v2/entities:search', 'POST', ctx)
    const sigB64 = token.split('.')[2]
    // base64url → bytes
    const sigBytes = Buffer.from(sigB64, 'base64url')
    expect(sigBytes.byteLength).toBe(64)
  })

  it('signature verifies against the embedded public JWK', async () => {
    const ctx = await _getDPoPContext()
    const htu = 'https://api.mercari.jp/v2/entities:search'
    const token = await _generateDPoP(htu, 'POST', ctx)
    const [headerB64, payloadB64, sigB64] = token.split('.')

    // Import public key from the JWK embedded in the header
    const headerJson = Buffer.from(headerB64, 'base64url').toString('utf8')
    const { jwk } = JSON.parse(headerJson)
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )

    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const signature = Buffer.from(sigB64, 'base64url')

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      publicKey,
      signature,
      signingInput,
    )
    expect(valid).toBe(true)
  })
})

describe('toProduct() price handling', () => {
  function makeItem(price: unknown) {
    return {
      id: 'x1',
      name: 'Test',
      price,
      description: '',
      thumbnails: [],
    }
  }

  it('parses numeric price', () => {
    const p = _toProduct(makeItem(23000), 'https://jp.mercari.com/item/x1')
    expect(p.price).toBe(23000)
  })

  it('parses string price "23000"', () => {
    const p = _toProduct(makeItem('23000'), 'https://jp.mercari.com/item/x1')
    expect(p.price).toBe(23000)
  })

  it('returns null for non-numeric price', () => {
    const p = _toProduct(makeItem('not-a-price'), 'https://jp.mercari.com/item/x1')
    expect(p.price).toBeNull()
  })

  it('returns null for null price', () => {
    const p = _toProduct(makeItem(null), 'https://jp.mercari.com/item/x1')
    expect(p.price).toBeNull()
  })
})

describe('toProduct() seller handling', () => {
  it('seller.idからセラーIDとプロフィールURLを保持する', () => {
    const product = _toProduct({
      id: 'x1',
      name: 'Test',
      price: 100,
      description: '',
      thumbnails: [],
      seller: { id: 12345 },
    }, 'https://jp.mercari.com/item/x1')

    expect(product.sellerId).toBe('12345')
    expect(product.sellerUrl).toBe('https://jp.mercari.com/user/profile/12345')
  })

  it('APIが返したプロフィールURLを優先する', () => {
    const product = _toProduct({
      id: 'x1',
      name: 'Test',
      price: 100,
      description: '',
      thumbnails: [],
      sellerInfo: {
        userId: 'abc',
        profileUrl: 'https://jp.mercari.com/s/abc',
      },
    }, 'https://jp.mercari.com/item/x1')

    expect(product.sellerId).toBe('abc')
    expect(product.sellerUrl).toBe('https://jp.mercari.com/s/abc')
  })
})

describe('toProduct() date handling', () => {
  function makeItemWithDate(updated: unknown) {
    return {
      id: 'x1',
      name: 'Test',
      price: 100,
      description: '',
      thumbnails: [],
      updated,
    }
  }

  it('converts Unix second number to ISO string', () => {
    const p = _toProduct(makeItemWithDate(1719548737), 'https://jp.mercari.com/item/x1')
    expect(p.sourceUpdatedAt).toBe(new Date(1719548737 * 1000).toISOString())
  })

  it('converts Unix second string "1719548737" to ISO string', () => {
    const p = _toProduct(makeItemWithDate('1719548737'), 'https://jp.mercari.com/item/x1')
    expect(p.sourceUpdatedAt).toBe(new Date(1719548737 * 1000).toISOString())
  })

  it('returns null for invalid date without throwing', () => {
    expect(() => {
      const p = _toProduct(makeItemWithDate('not-a-date'), 'https://jp.mercari.com/item/x1')
      expect(p.sourceUpdatedAt).toBeNull()
    }).not.toThrow()
  })

  it('returns null when date field is absent', () => {
    const p = _toProduct({ id: 'x1', name: 'T', price: 1, description: '', thumbnails: [] }, 'https://jp.mercari.com/item/x1')
    expect(p.sourceUpdatedAt).toBeNull()
  })
})

describe('Mercari item images', () => {
  const fullImages = [
    'https://static.mercdn.net/item/detail/orig/photos/m1_1.jpg?1',
    'https://static.mercdn.net/item/detail/orig/photos/m1_2.jpg?2',
    'https://static.mercdn.net/item/detail/orig/photos/m1_3.jpg?3',
  ]

  it('商品詳細の全画像を順番どおり抽出し、重複を除外する', () => {
    expect(_extractImages({
      photos: [
        fullImages[0],
        { image_url: fullImages[1] },
        { uri: fullImages[2] },
      ],
      thumbnails: [fullImages[0]],
    })).toEqual(fullImages)
  })

  it('検索結果の商品を詳細APIで補完して全画像を返す', async () => {
    const originalFetch = globalThis.fetch
    const detailRequests: Array<{ url: string; dpop: string | null }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input)
      if (requestUrl.includes('entities:search')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'm1',
            name: 'Test item',
            price: 1000,
            thumbnails: ['https://static.mercdn.net/thumb.jpg'],
          }],
        }), { status: 200 })
      }
      if (requestUrl.includes('/items/get?id=m1')) {
        const headers = new Headers(init?.headers)
        detailRequests.push({ url: requestUrl, dpop: headers.get('DPoP') })
        return new Response(JSON.stringify({
          data: {
            id: 'm1',
            name: 'Test item',
            price: 1000,
            photos: fullImages,
          },
        }), { status: 200 })
      }
      return new Response(null, { status: 404 })
    }

    try {
      const products = await new MercariScraper().scrape(
        'https://jp.mercari.com/search?keyword=test',
        { limit: 1 },
      )
      expect(products[0].images).toEqual(fullImages)
      expect(detailRequests).toHaveLength(1)
      expect(detailRequests[0].dpop).toBeTruthy()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('詳細APIが失敗した商品は一覧画像を残して抽出を継続する', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const requestUrl = String(input)
      if (requestUrl.includes('entities:search')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'm1',
            name: 'Test item',
            price: 1000,
            thumbnails: ['https://static.mercdn.net/thumb.jpg'],
          }],
        }), { status: 200 })
      }
      return new Response(null, { status: 503 })
    }

    try {
      const products = await new MercariScraper().scrape(
        'https://jp.mercari.com/search?keyword=test',
        { limit: 1 },
      )
      expect(products[0].images).toEqual(['https://static.mercdn.net/thumb.jpg'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('詳細APIが404でもCDN連番画像から複数画像を補完する', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input)
      if (requestUrl.includes('entities:search')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'm1',
            name: 'Test item',
            price: 1000,
            thumbnails: ['https://static.mercdn.net/thumb.jpg'],
          }],
        }), { status: 200 })
      }
      if (requestUrl.includes('/items/get?id=m1')) {
        return new Response(null, { status: 404 })
      }
      if (init?.method === 'HEAD' && requestUrl.includes('/m1_')) {
        const imageNumber = Number(requestUrl.match(/_([0-9]+)\.jpg$/)?.[1])
        return new Response(null, { status: imageNumber <= 2 ? 200 : 403 })
      }
      return new Response(null, { status: 404 })
    }

    try {
      const products = await new MercariScraper().scrape(
        'https://jp.mercari.com/search?keyword=test',
        { limit: 1 },
      )
      expect(products[0].images).toEqual([
        'https://static.mercdn.net/item/detail/orig/photos/m1_1.jpg',
        'https://static.mercdn.net/item/detail/orig/photos/m1_2.jpg',
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('単品詳細APIが404でも商品ページとCDNから商品と全画像を取得する', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input)
      if (requestUrl.includes('/items/get?id=m13676694000')) {
        return new Response(null, { status: 404 })
      }
      if (requestUrl === 'https://jp.mercari.com/item/m13676694000') {
        return new Response([
          '<html><head>',
          '<meta property="og:title" content="ポケモンコロシアム 拡張ディスク by メルカリ"/>',
          '<meta name="product:price:amount" content="19800"/>',
          '<meta property="og:image" content="https://static.mercdn.net/item/detail/orig/photos/m13676694000_1.jpg?1"/>',
          '</head></html>',
        ].join(''), { status: 200 })
      }
      if (init?.method === 'HEAD' && requestUrl.includes('/m13676694000_')) {
        const imageNumber = Number(requestUrl.match(/_([0-9]+)\.jpg$/)?.[1])
        return new Response(null, { status: imageNumber <= 6 ? 200 : 403 })
      }
      return new Response(null, { status: 404 })
    }

    try {
      const products = await new MercariScraper().scrape(
        'https://jp.mercari.com/item/m13676694000?deepbay_refresh=1',
      )
      expect(products).toHaveLength(1)
      expect(products[0].title).toBe('ポケモンコロシアム 拡張ディスク')
      expect(products[0].price).toBe(19800)
      expect(products[0].images).toHaveLength(6)
      expect(products[0].images[5]).toBe(
        'https://static.mercdn.net/item/detail/orig/photos/m13676694000_6.jpg',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('getMultiNumberParam()', () => {
  it('parses comma-separated value: item_condition_id=2%2C3%2C4%2C5 → [2,3,4,5]', () => {
    const params = new URLSearchParams('item_condition_id=2%2C3%2C4%2C5')
    expect(_getMultiNumberParam(params, 'item_condition_id')).toEqual([2, 3, 4, 5])
  })

  it('parses repeated keys: item_condition_id=2&item_condition_id=3 → [2,3]', () => {
    const params = new URLSearchParams('item_condition_id=2&item_condition_id=3')
    expect(_getMultiNumberParam(params, 'item_condition_id')).toEqual([2, 3])
  })

  it('filters out non-numeric and empty values', () => {
    const params = new URLSearchParams('item_condition_id=2%2C%2Cfoo%2C4')
    expect(_getMultiNumberParam(params, 'item_condition_id')).toEqual([2, 4])
  })

  it('returns empty array when key is absent', () => {
    const params = new URLSearchParams('')
    expect(_getMultiNumberParam(params, 'item_condition_id')).toEqual([])
  })
})

describe('scrapeSearch excludeKeyword', () => {
  it('exclude_keyword param is passed to searchCondition.excludeKeyword', async () => {
    // We verify by checking the fetch body constructed from a URL with exclude_keyword
    // Intercept fetch to capture the request body
    const calls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string' && input.includes('entities:search')) {
        calls.push(init?.body as string ?? '')
        // Return an empty result to stop pagination
        return new Response(JSON.stringify({ items: [] }), { status: 200 })
      }
      return origFetch(input, init)
    }

    try {
      const { MercariScraper } = await import('../lib/scrapers/mercari')
      const scraper = new MercariScraper()
      await scraper.scrape('https://jp.mercari.com/search?keyword=nike&exclude_keyword=%E3%81%BE%E3%81%A8%E3%82%81%E5%A3%B2%E3%82%8A').catch(() => {})
    } finally {
      globalThis.fetch = origFetch
    }

    expect(calls.length).toBeGreaterThan(0)
    const body = JSON.parse(calls[0])
    expect(body.searchCondition.excludeKeyword).toBe('まとめ売り')
  })
})

describe('scrapeSearch pagination', () => {
  it('要求件数より少ないページでもnextPageTokenがあれば次ページを取得する', async () => {
    const originalFetch = globalThis.fetch
    const requestBodies: Array<{ pageSize: number; pageToken: string }> = []
    let searchRequestCount = 0

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input)
      if (!requestUrl.includes('entities:search')) {
        return new Response(null, { status: 404 })
      }

      requestBodies.push(JSON.parse(String(init?.body)))
      searchRequestCount += 1

      if (searchRequestCount === 1) {
        return new Response(JSON.stringify({
          items: Array.from({ length: 118 }, (_, index) => ({
            name: `Item ${index + 1}`,
            price: 1000,
            thumbnails: [],
          })),
          meta: { nextPageToken: 'page-2' },
        }), { status: 200 })
      }

      return new Response(JSON.stringify({
        items: Array.from({ length: 2 }, (_, index) => ({
          name: `Item ${119 + index}`,
          price: 1000,
          thumbnails: [],
        })),
      }), { status: 200 })
    }

    try {
      const products = await new MercariScraper().scrape(
        'https://jp.mercari.com/search?keyword=test',
        { limit: 120 },
      )

      expect(products).toHaveLength(120)
      expect(requestBodies).toHaveLength(2)
      expect(requestBodies[0]).toMatchObject({ pageSize: 120, pageToken: '' })
      expect(requestBodies[1]).toMatchObject({ pageSize: 120, pageToken: 'page-2' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('同じnextPageTokenが繰り返された場合は安全に停止する', async () => {
    const originalFetch = globalThis.fetch
    let searchRequestCount = 0

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const requestUrl = String(input)
      if (!requestUrl.includes('entities:search')) {
        return new Response(null, { status: 404 })
      }

      searchRequestCount += 1
      return new Response(JSON.stringify({
        items: [{ name: `Item ${searchRequestCount}`, price: 1000, thumbnails: [] }],
        meta: { nextPageToken: 'same-token' },
      }), { status: 200 })
    }

    try {
      const products = await new MercariScraper().scrape(
        'https://jp.mercari.com/search?keyword=test',
        { limit: 120 },
      )

      expect(products).toHaveLength(2)
      expect(searchRequestCount).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
