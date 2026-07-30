import { describe, expect, it } from 'vitest'
import { findDangerWordMatch, normalizeDangerWord } from '@/lib/danger-word'

describe('danger word matching', () => {
  it('英数字は独立した単語として一致する', () => {
    expect(findDangerWordMatch('BLOOD GEAR collectible', ['Blood'])).toEqual({
      registeredWord: 'Blood',
      normalizedWord: 'blood',
    })
  })

  it.each([
    ['GUNHED figure', 'Gun'],
    ['HEROES collection', 'Ero'],
    ['GINKA game software', 'Ink'],
    ['Bloody Wolf', 'Blood'],
  ])('英単語の一部分には誤一致しない: %s / %s', (text, word) => {
    expect(findDangerWordMatch(text, [word])).toBeNull()
  })

  it('記号だけの登録値は無視する', () => {
    expect(findDangerWordMatch('商品_説明', ['_'])).toBeNull()
  })

  it('日本語は商品説明内の部分一致で判定する', () => {
    expect(findDangerWordMatch('こちらは模造品ではありません', ['模造品'])?.registeredWord)
      .toBe('模造品')
  })

  it('大文字小文字と全角英数字を正規化する', () => {
    expect(findDangerWordMatch('This is NIKE footwear', ['Ｎｉｋｅ'])?.normalizedWord)
      .toBe('nike')
  })

  it('CSV由来の引用符やバックスラッシュを除いて正規化する', () => {
    expect(normalizeDangerWord('\\"All About Her Group"')).toBe('all about her group')
  })
})
