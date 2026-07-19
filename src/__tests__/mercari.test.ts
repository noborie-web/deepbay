import { describe, it, expect } from 'vitest'
import { _getDPoPContext, _generateDPoP, _toProduct, _getMultiNumberParam } from '../lib/scrapers/mercari'

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
