import { describe, expect, it } from 'vitest'
import {
  findDuplicateTitleIds,
  matchesReviewFilter,
  normalizeTitleForDuplicate,
  productReviewFlags,
  sortDuplicatesTogether,
  type ReviewItem,
} from '@/lib/product-review'

// ユーザー要望(2026-10-18): 数百件の商品から「不要なもの」を目視で見つけて消したい。
// 端から見るのは現実的でないので、怪しいものに絞り込めるようにする。

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'p1',
    title: 'Shimano Genuine Reel Case M Size',
    brand: 'Shimano',
    description: '説明文があります',
    price: 50,
    images: ['a.jpg', 'b.jpg', 'c.jpg'],
    ...overrides,
  }
}

describe('productReviewFlags', () => {
  const noDup = new Set<string>()

  it('問題が無ければ何も付かない', () => {
    expect(productReviewFlags(item(), noDup)).toEqual([])
  })

  it('画像が1枚以下を拾う（出品の見栄えが悪い）', () => {
    expect(productReviewFlags(item({ images: ['a.jpg'] }), noDup)).toContain('few_images')
    expect(productReviewFlags(item({ images: [] }), noDup)).toContain('few_images')
    expect(productReviewFlags(item({ images: ['a.jpg', 'b.jpg'] }), noDup)).not.toContain('few_images')
  })

  it('説明文が空を拾う（空白だけも空とみなす）', () => {
    expect(productReviewFlags(item({ description: '' }), noDup)).toContain('no_description')
    expect(productReviewFlags(item({ description: '   ' }), noDup)).toContain('no_description')
  })

  it('eBay販売価格が未設定を拾う', () => {
    expect(productReviewFlags(item({ price: null }), noDup)).toContain('no_price')
    // 0円は「未設定」ではない（別の問題として扱う）
    expect(productReviewFlags(item({ price: 0 }), noDup)).not.toContain('no_price')
  })

  it('タイトルが上限80文字に近いものを拾う', () => {
    expect(productReviewFlags(item({ title: 'a'.repeat(75) }), noDup)).toContain('long_title')
    expect(productReviewFlags(item({ title: 'a'.repeat(74) }), noDup)).not.toContain('long_title')
  })

  it('ブランド未設定を拾う', () => {
    expect(productReviewFlags(item({ brand: '' }), noDup)).toContain('no_brand')
  })

  it('重複タイトルを拾う', () => {
    expect(productReviewFlags(item(), new Set(['p1']))).toContain('duplicate_title')
  })
})

describe('タイトル重複の判定', () => {
  it('大文字小文字・空白・記号の違いは同じものとして扱う', () => {
    expect(normalizeTitleForDuplicate('Shimano  REEL-Case!')).toBe(normalizeTitleForDuplicate('shimano reel case'))
  })

  it('全角空白もそろえる', () => {
    expect(normalizeTitleForDuplicate('シマノ　リールケース')).toBe(normalizeTitleForDuplicate('シマノ リールケース'))
  })

  it('2件以上あるタイトルの商品だけを返す', () => {
    const ids = findDuplicateTitleIds([
      item({ id: 'a', title: 'Shimano Reel Case' }),
      item({ id: 'b', title: 'shimano  reel case' }),
      item({ id: 'c', title: '別の商品' }),
    ])
    expect(ids).toEqual(new Set(['a', 'b']))
  })

  it('タイトルが空の商品は重複に数えない', () => {
    expect(findDuplicateTitleIds([item({ id: 'a', title: '' }), item({ id: 'b', title: '  ' })])).toEqual(new Set())
  })

  // 見比べてどちらを消すか決められるよう、重複は隣り合わせに並べる
  it('重複を先頭にまとめ、同じタイトルを隣り合わせにする', () => {
    const items = [
      item({ id: 'a', title: 'Reel Case' }),
      item({ id: 'b', title: 'Rod' }),
      item({ id: 'c', title: 'reel case' }),
      item({ id: 'd', title: 'Lure' }),
    ]
    const sorted = sortDuplicatesTogether(items, findDuplicateTitleIds(items))
    expect(sorted.map((p) => p.id)).toEqual(['a', 'c', 'b', 'd'])
  })
})

describe('matchesReviewFilter', () => {
  it('条件を選んでいなければ全件残す', () => {
    expect(matchesReviewFilter([], new Set())).toBe(true)
    expect(matchesReviewFilter(['no_price'], new Set())).toBe(true)
  })

  // 「怪しいものを集める」ための絞り込みなので、どれかに当てはまれば残す
  it('選んだ条件のどれかに当てはまれば残す', () => {
    expect(matchesReviewFilter(['no_price', 'few_images'], new Set(['few_images']))).toBe(true)
    expect(matchesReviewFilter(['no_price'], new Set(['few_images']))).toBe(false)
    expect(matchesReviewFilter([], new Set(['few_images']))).toBe(false)
  })
})
