import { describe, it, expect } from 'vitest'
import { _getDPoPContext, _generateDPoP, _toProduct } from '../lib/scrapers/mercari'

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
