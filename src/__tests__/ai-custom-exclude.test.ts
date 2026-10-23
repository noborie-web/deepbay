import { describe, it, expect } from 'vitest'
import { parseVerdict, systemPrompt } from '@/lib/product-classify'
import { instructionKeyOf } from '@/app/api/products/[extractionId]/classify/route'
import { isExcludeVerdict, productReviewFlags, REVIEW_FLAG_LABELS } from '@/lib/product-review'

const item = {
  id: 'p1', title: 'Neo Geo Pocket', images: ['a', 'b'], description: 'x',
  price: 10, brand: 'SNK', originalTitle: 'ネオジオポケット',
}

describe('その場の指示でAIに除外を判定させる', () => {
  it('指示があれば exclude / keep で判定するプロンプトになる', () => {
    const prompt = systemPrompt('ゲーム機', 'ジャンク品を除外')
    expect(prompt).toContain('ジャンク品を除外')
    expect(prompt).toContain('exclude|keep|unknown')
    // 迷ったら消さない向きに倒す
    expect(prompt).toContain('迷ったら unknown')
  })

  it('指示が空なら従来どおり本体か部品かを判定する', () => {
    const prompt = systemPrompt('リール', '')
    expect(prompt).toContain('main|part|unknown')
    expect(prompt).not.toContain('exclude|keep')
  })

  it('custom モードで main/part が返ってきても採用しない', () => {
    // モード外の値を受け入れると、指示と関係ない判定が混ざる
    expect(parseVerdict('{"verdict":"part","reason":"x"}', 'custom').verdict).toBe('unknown')
    expect(parseVerdict('{"verdict":"exclude","reason":"x"}', 'custom').verdict).toBe('exclude')
  })

  it('part モードで exclude が返ってきても採用しない', () => {
    expect(parseVerdict('{"verdict":"exclude","reason":"x"}', 'part').verdict).toBe('unknown')
    expect(parseVerdict('{"verdict":"part","reason":"x"}', 'part').verdict).toBe('part')
  })

  it('指示を変えたら別のキーになる(= 判定し直す)', () => {
    const a = instructionKeyOf('ジャンク品を除外')
    const b = instructionKeyOf('パーツ取りを除外')
    expect(a).not.toBe(b)
    // 同じ指示(前後の空白違い)は同じキー = 続きから再開できる
    expect(instructionKeyOf('  ジャンク品を除外 ')).toBe(a)
    // 指示なしは従来どおり
    expect(instructionKeyOf('')).toBeNull()
    expect(instructionKeyOf(null)).toBeNull()
  })

  it('キーは英数字だけ(PostgRESTのor(...)を壊さない)', () => {
    // 指示にカンマや括弧が入っても安全であること
    expect(instructionKeyOf('a,b)(c.d')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('exclude は除外候補として扱い、絞り込みに出る', () => {
    expect(isExcludeVerdict('exclude')).toBe(true)
    expect(isExcludeVerdict('part')).toBe(true)
    expect(isExcludeVerdict('keep')).toBe(false)
    expect(isExcludeVerdict('unknown')).toBe(false)
    expect(productReviewFlags({ ...item, aiVerdict: 'exclude' }, new Set())).toContain('ai_exclude')
    expect(productReviewFlags({ ...item, aiVerdict: 'keep' }, new Set())).not.toContain('ai_exclude')
    expect(REVIEW_FLAG_LABELS.ai_exclude).toBe('AI判定: 除外')
  })
})
