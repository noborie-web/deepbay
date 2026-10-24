import { describe, it, expect } from 'vitest'
import { dedupeMercariImages } from '@/lib/scrapers/mercari'
import { needsDetailEnrichment } from '@/lib/extraction-run'
import { ENRICHABLE_SITES } from '@/lib/enrich-sites'

const ORIG = (id: string, n: number) => `https://static.mercdn.net/item/detail/orig/photos/${id}_${n}.jpg?123`
const WEBP = (id: string, n: number) => `https://static.mercdn.net/item/detail/webp/photos/${id}_${n}.jpg?123`
const THUMB = (id: string, n: number) => `https://static.mercdn.net/thumb/item/webp/${id}_${n}.jpg?123`

describe('メルカリ画像の重複排除', () => {
  // ユーザー報告(2026-10-24): 同じ画像が2枚取得されている。
  // 実データ: 詳細サイズとサムネイルが別URLで、どちらも1枚目の写真だった。
  it('同じ写真のサイズ違いを1枚にまとめる', () => {
    expect(dedupeMercariImages([WEBP('m1', 1), THUMB('m1', 1)])).toEqual([WEBP('m1', 1)])
  })

  it('いちばん大きいものを残す(原寸 > 詳細 > サムネイル)', () => {
    expect(dedupeMercariImages([THUMB('m1', 1), WEBP('m1', 1), ORIG('m1', 1)])).toEqual([ORIG('m1', 1)])
    expect(dedupeMercariImages([ORIG('m1', 1), THUMB('m1', 1)])).toEqual([ORIG('m1', 1)])
  })

  it('違う写真は残す', () => {
    const r = dedupeMercariImages([ORIG('m1', 1), ORIG('m1', 2), THUMB('m1', 1), ORIG('m1', 3)])
    expect(r).toEqual([ORIG('m1', 1), ORIG('m1', 2), ORIG('m1', 3)])
  })

  it('最初に出てきた順番を保つ(1枚目がAI判定と出品の先頭になる)', () => {
    const r = dedupeMercariImages([ORIG('m1', 2), ORIG('m1', 1)])
    expect(r).toEqual([ORIG('m1', 2), ORIG('m1', 1)])
  })

  it('写真番号が読めないURLはそのまま残す', () => {
    const other = 'https://example.com/a.png'
    expect(dedupeMercariImages([other, ORIG('m1', 1)])).toEqual([other, ORIG('m1', 1)])
  })
})

describe('詳細補完が要るかの判定', () => {
  // サイト名で決め打ちしていたため、メルカリ407件中357件(88%)が画像2枚以下の
  // まま「取得済み」になっていた。実際に取れたかで判断する。
  it('説明文が無ければ補完が要る', () => {
    expect(needsDetailEnrichment({ description: '', images: [ORIG('m1', 1), ORIG('m1', 2)] })).toBe(true)
    expect(needsDetailEnrichment({ description: '   ', images: [] })).toBe(true)
    expect(needsDetailEnrichment({ description: null, images: [] })).toBe(true)
  })

  it('写真が1枚以下なら補完が要る', () => {
    expect(needsDetailEnrichment({ description: 'あり', images: [ORIG('m1', 1)] })).toBe(true)
    expect(needsDetailEnrichment({ description: 'あり', images: [] })).toBe(true)
  })

  it('説明文も写真も揃っていれば補完は不要', () => {
    expect(needsDetailEnrichment({ description: 'あり', images: [ORIG('m1', 1), ORIG('m1', 2)] })).toBe(false)
  })

  it('メルカリも補完の対象サイトに入っている', () => {
    expect(ENRICHABLE_SITES).toContain('mercari')
  })
})
