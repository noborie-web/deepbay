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

// ユーザー要望: 「危険セラーの除外は必須です」。抽出結果内の個別商品単位で
// 危険セラー判定できるよう、出品者URLを取得する。実データ確認: entities:search /
// items/get のレスポンスは出品者IDをitem.sellerIdに直接持つ。
describe('toProduct() sellerUrl handling', () => {
  it('item.sellerIdから出品者プロフィールURLを組み立てる', () => {
    const p = _toProduct({ id: 'm1', name: 'Test', sellerId: '788452260' }, 'https://jp.mercari.com/item/m1')
    expect(p.sellerUrl).toBe('https://jp.mercari.com/user/profile/788452260')
  })

  it('sellerIdが存在しない場合はnullになる', () => {
    const p = _toProduct({ id: 'm1', name: 'Test' }, 'https://jp.mercari.com/item/m1')
    expect(p.sellerUrl).toBeNull()
  })
})

describe('toProduct() availability handling', () => {
  const item = { id: 'x1', name: 'Test', price: 100, description: '', thumbnails: [] }

  it.each(['STATUS_SOLD_OUT', 'sold_out', 'STATUS_TRADING'])('maps %s to sold_out', (status) => {
    expect(_toProduct({ ...item, status }, 'https://jp.mercari.com/item/x1').availability).toBe('sold_out')
  })

  it('maps STATUS_ON_SALE to available', () => {
    const status = 'STATUS_ON_SALE'
    expect(_toProduct({ ...item, status }, 'https://jp.mercari.com/item/x1').availability).toBe('available')
  })

  it('maps a missing or unrecognized status to unknown', () => {
    expect(_toProduct(item, 'https://jp.mercari.com/item/x1').availability).toBe('unknown')
    expect(_toProduct({ ...item, status: 'STATUS_UNKNOWN' }, 'https://jp.mercari.com/item/x1').availability).toBe('unknown')
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
  it('メルカリAPIがpageSizeより少ない件数を返してもnextPageTokenがあれば次ページを取得し続ける', async () => {
    // 実際のMercari検索APIの挙動を再現: pageSize=120でも1ページ目は90件しか
    // 返さないが、meta.nextPageTokenは有効で、まだ後続ページに結果が存在する。
    // 「返却件数 < pageSize」を終了条件にしてはいけない(このバグで実際に
    // 抽出数が90件程度で頭打ちになっていた)。
    const pages = [
      { items: Array.from({ length: 90 }, (_, i) => ({ id: `m1${i}`, name: `item1-${i}`, price: 1000 })), meta: { nextPageToken: 'token-2' } },
      { items: Array.from({ length: 90 }, (_, i) => ({ id: `m2${i}`, name: `item2-${i}`, price: 2000 })), meta: { nextPageToken: 'token-3' } },
      { items: Array.from({ length: 40 }, (_, i) => ({ id: `m3${i}`, name: `item3-${i}`, price: 3000 })), meta: { nextPageToken: '' } },
    ]
    let callIndex = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      if (urlStr.includes('entities:search')) {
        const page = pages[Math.min(callIndex, pages.length - 1)]
        callIndex += 1
        return new Response(JSON.stringify(page), { status: 200 })
      }
      // 画像補完(enrichImages)が実ネットワークへ出ないよう、それ以外は即404を返す
      return new Response('', { status: 404 })
    }

    try {
      const { MercariScraper } = await import('../lib/scrapers/mercari')
      const scraper = new MercariScraper()
      const results = await scraper.scrape('https://jp.mercari.com/search?keyword=test', { limit: 220 })
      expect(results.length).toBe(220)
      expect(callIndex).toBe(3)
    } finally {
      globalThis.fetch = origFetch
    }
  }, 15000)

  it('nextPageTokenが無い場合は1ページで終了する', async () => {
    const origFetch = globalThis.fetch
    let callIndex = 0
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      if (urlStr.includes('entities:search')) {
        callIndex += 1
        return new Response(JSON.stringify({
          items: Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, name: `item-${i}`, price: 500 })),
          meta: {},
        }), { status: 200 })
      }
      // 画像補完(enrichImages)が実ネットワークへ出ないよう、それ以外は即404を返す
      return new Response('', { status: 404 })
    }

    try {
      const { MercariScraper } = await import('../lib/scrapers/mercari')
      const scraper = new MercariScraper()
      const results = await scraper.scrape('https://jp.mercari.com/search?keyword=test', { limit: 600 })
      expect(results.length).toBe(50)
      expect(callIndex).toBe(1)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('MercariScraper セラーページ抽出', () => {
  it('urlPatternが/s/{id}と/user/profile/{id}の両方にマッチする', () => {
    const scraper = new MercariScraper()
    expect(scraper.urlPattern.test('https://jp.mercari.com/s/430735560')).toBe(true)
    expect(scraper.urlPattern.test('https://jp.mercari.com/user/profile/430735560')).toBe(true)
  })

  it('/user/profile/{id}形式のURLからentities:searchにsellerIdを指定してリクエストする', async () => {
    const origFetch = globalThis.fetch
    const requestBodies: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      if (urlStr.includes('entities:search')) {
        requestBodies.push(init?.body as string ?? '')
        return new Response(JSON.stringify({
          items: [{ id: 'm1', name: 'seller item 1', price: 1000 }],
          meta: {},
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }

    try {
      const scraper = new MercariScraper()
      const results = await scraper.scrape('https://jp.mercari.com/user/profile/430735560', { limit: 10 })
      expect(results).toHaveLength(1)
      expect(requestBodies.length).toBeGreaterThan(0)
      const body = JSON.parse(requestBodies[0])
      expect(body.searchCondition.sellerId).toEqual(['430735560'])
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('旧来の/s/{id}形式のURLからも同じくsellerId検索を実行する', async () => {
    const origFetch = globalThis.fetch
    const requestBodies: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString()
      if (urlStr.includes('entities:search')) {
        requestBodies.push(init?.body as string ?? '')
        return new Response(JSON.stringify({
          items: [{ id: 'm2', name: 'seller item 2', price: 2000 }],
          meta: {},
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }

    try {
      const scraper = new MercariScraper()
      const results = await scraper.scrape('https://jp.mercari.com/s/430735560', { limit: 10 })
      expect(results).toHaveLength(1)
      const body = JSON.parse(requestBodies[0])
      expect(body.searchCondition.sellerId).toEqual(['430735560'])
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
