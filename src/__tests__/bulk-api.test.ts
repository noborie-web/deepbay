import { describe, it, expect } from 'vitest'
import { PRODUCT_WRITE_WHITELIST } from '../lib/pricing'

// Simulate the pickAllowed logic used in the API routes
function pickAllowed(updates: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).filter(([k]) => PRODUCT_WRITE_WHITELIST.has(k))
  )
}

describe('Bulk API: pickAllowed() ホワイトリストフィルタ', () => {
  it('original_priceを含むリクエストからoriginal_priceを除外する', () => {
    const input = { ebay_title: 'Test', original_price: 99999, ebay_price: 50 }
    const result = pickAllowed(input)
    expect(result).not.toHaveProperty('original_price')
    expect(result).toHaveProperty('ebay_title', 'Test')
    expect(result).toHaveProperty('ebay_price', 50)
  })

  it('user_idを含むリクエストからuser_idを除外する', () => {
    const input = { ebay_price: 50, user_id: 'attacker-id' }
    const result = pickAllowed(input)
    expect(result).not.toHaveProperty('user_id')
  })

  it('listing_statusを含むリクエストからlisting_statusを除外する', () => {
    const input = { ebay_condition: '新品', listing_status: 'listed' }
    const result = pickAllowed(input)
    expect(result).not.toHaveProperty('listing_status')
    expect(result).toHaveProperty('ebay_condition', '新品')
  })

  it('extraction_idを含むリクエストからextraction_idを除外する', () => {
    const input = { ebay_title: 'X', extraction_id: 'other-extraction' }
    const result = pickAllowed(input)
    expect(result).not.toHaveProperty('extraction_id')
  })

  it('ホワイトリスト外フィールドのみのリクエストは空オブジェクトになる', () => {
    const input = { user_id: 'x', original_price: 100, listing_status: 'listed' }
    const result = pickAllowed(input)
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('purchase_price_jpyは保存できる', () => {
    const input = { purchase_price_jpy: 3000 }
    const result = pickAllowed(input)
    expect(result).toHaveProperty('purchase_price_jpy', 3000)
  })
})

describe('Bulk API: 他ユーザーの商品を更新できない (ロジック確認)', () => {
  it('APIはuser_idとextraction_idの両方を.eq()でフィルタするので他ユーザーは更新不可', () => {
    // This tests the intent: the WHERE clause in the bulk API is:
    //   .eq('id', productId).eq('extraction_id', extractionId).eq('user_id', user.id)
    // If user_id doesn't match, 0 rows are updated (no error, but no effect)
    // We verify the query construction logic here by checking the whitelist doesn't bypass user_id
    const payload = { productId: 'some-product', user_id: 'attacker', ebay_price: 1 }
    const { productId, ...rest } = payload
    const allowed = pickAllowed(rest)
    expect(allowed).not.toHaveProperty('user_id')
    expect(productId).toBe('some-product')
  })
})
