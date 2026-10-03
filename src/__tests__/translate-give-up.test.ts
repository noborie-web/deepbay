import { beforeEach, describe, expect, it, vi } from 'vitest'

// 本番で確認した不具合(2026-10-03): 抽出が90%(ページ取得完了)のあとAI処理中に
// 実行時間の上限(300秒)で強制終了され、商品が0件になった。残り時間が無く
// なったら、残りの商品はAI呼び出しをせず元の文章のまま進める。
const mocks = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mocks.create } }
  },
}))

import {
  extractBrandsSafely,
  generateDescriptionsSafely,
  translateDescriptionsWithFailures,
  translateTitlesWithFailures,
} from '@/lib/translate'

describe('AI処理の打ち切り(giveUp)', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key'
    mocks.create.mockReset().mockResolvedValue({ choices: [{ message: { content: 'Translated' } }] })
  })

  it('タイトル翻訳: 打ち切った商品はAPIを呼ばず、元タイトルのまま「失敗ではない」として返す', async () => {
    // 最初の2件だけ翻訳し、それ以降は打ち切る
    let done = 0
    mocks.create.mockImplementation(async () => {
      done += 1
      return { choices: [{ message: { content: `EN${done}` } }] }
    })
    const results = await translateTitlesWithFailures(['あ', 'い', 'う', 'え'], 'high', {
      concurrency: 1,
      giveUp: () => done >= 2,
    })

    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(results.slice(2)).toEqual([
      { title: 'う', failed: false },
      { title: 'え', failed: false },
    ])
    // 打ち切りは「翻訳失敗」ではないので商品は除外されない
    expect(results.every((r) => r.failed === false)).toBe(true)
  })

  it('説明文翻訳: 打ち切った商品は元の説明文のまま返す', async () => {
    const results = await translateDescriptionsWithFailures(['説明1', '説明2'], 'high', {
      concurrency: 1,
      giveUp: () => true,
    })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(results).toEqual([
      { description: '説明1', failed: false },
      { description: '説明2', failed: false },
    ])
  })

  it('ブランド抽出・説明文生成: 打ち切った商品はAPIを呼ばない', async () => {
    const brands = await extractBrandsSafely([{ title: 'T', description: 'D' }], 'high', { giveUp: () => true })
    const generated = await generateDescriptionsSafely(
      [{ title: 'T', condition: null, category: null, brand: null, hashtags: null, originalDescription: '' }],
      'high',
      { giveUp: () => true },
    )
    expect(mocks.create).not.toHaveBeenCalled()
    expect(brands).toEqual([null])
    expect(generated).toEqual([{ description: null, failed: true }])
  })

  it('1件ごとに上限時間を付けてAPIを呼ぶ(ハングで抽出全体を止めない)', async () => {
    await translateTitlesWithFailures(['あ'], 'high')
    expect(mocks.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeout: expect.any(Number), maxRetries: expect.any(Number) }),
    )
  })
})
