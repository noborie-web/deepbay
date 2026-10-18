import { describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import { classifyProduct, parseVerdict } from '@/lib/product-classify'

// ユーザー要望(2026-10-18): リールのカテゴリに混ざるスプール・ハンドル等を
// AIで見分けたい。キーワードでは拾えない(「Light Arm」「ドラググリス」のように
// 部品名が商品名化していて語彙に限りがない)。
// タイトルと1枚目の画像を一度に見せ、互いの弱点を補わせる。

describe('parseVerdict', () => {
  it('JSONの判定を読む', () => {
    expect(parseVerdict('{"verdict":"part","reason":"スプール単体"}'))
      .toEqual({ verdict: 'part', reason: 'スプール単体' })
  })

  it('```json で包まれていても読む', () => {
    expect(parseVerdict('```json\n{"verdict":"main","reason":"リール本体"}\n```'))
      .toEqual({ verdict: 'main', reason: 'リール本体' })
  })

  // 読めない応答で商品を消してしまわないよう、必ず unknown に倒す
  it('壊れた応答・空・未知の値は unknown にする', () => {
    expect(parseVerdict('これはJSONではありません').verdict).toBe('unknown')
    expect(parseVerdict('').verdict).toBe('unknown')
    expect(parseVerdict(null).verdict).toBe('unknown')
    expect(parseVerdict('{"verdict":"maybe"}').verdict).toBe('unknown')
  })

  it('長すぎる理由は切り詰める', () => {
    const long = parseVerdict(`{"verdict":"part","reason":"${'あ'.repeat(200)}"}`)
    expect(long.reason.length).toBeLessThanOrEqual(60)
  })
})

interface ChatPayload {
  messages: Array<{ role: string; content: unknown }>
}

function fakeOpenAI(reply: string | Error) {
  const create = vi.fn(async (payload: ChatPayload) => {
    void payload
    if (reply instanceof Error) throw reply
    return { choices: [{ message: { content: reply } }] }
  })
  return { openai: { chat: { completions: { create } } } as unknown as OpenAI, create }
}

const input = {
  id: 'p1',
  title: 'Yume-ya 13 STELLA SW14000 Powered Drag Spool',
  originalTitle: '夢屋 13 STELLA ステラ SW14000 パワードラグスプール',
  imageUrl: 'https://auctions.c.yimg.jp/example.jpg',
}

describe('classifyProduct', () => {
  it('タイトルと画像を1回の問い合わせで渡す', async () => {
    const { openai, create } = fakeOpenAI('{"verdict":"part","reason":"スプール単体"}')
    const result = await classifyProduct(openai, input, { expectedCategory: 'ダイワ スピニングリール' })

    expect(result).toMatchObject({ verdict: 'part', reason: 'スプール単体' })
    const payload = create.mock.calls[0][0]
    const userContent = payload.messages[1].content as Array<Record<string, unknown>>
    // 画像は1枚だけ、かつ detail: low(費用と時間を抑える)
    const images = userContent.filter((part) => part.type === 'image_url')
    expect(images).toHaveLength(1)
    expect(images[0].image_url).toEqual({ url: input.imageUrl, detail: 'low' })
    // 英語と日本語の両方のタイトルを渡す
    const text = String((userContent.find((part) => part.type === 'text') as { text: string }).text)
    expect(text).toContain('Powered Drag Spool')
    expect(text).toContain('パワードラグスプール')
    // 何を集めた一覧かを判定の手がかりにする
    expect(String(payload.messages[0].content)).toContain('ダイワ スピニングリール')
  })

  it('画像が無ければタイトルだけで判定する', async () => {
    const { openai, create } = fakeOpenAI('{"verdict":"main","reason":"リール本体"}')
    const result = await classifyProduct(openai, { ...input, imageUrl: null })

    expect(result.verdict).toBe('main')
    const payload = create.mock.calls[0][0]
    const userContent = payload.messages[1].content as Array<Record<string, unknown>>
    expect(userContent.filter((part) => part.type === 'image_url')).toHaveLength(0)
  })

  // 判定できなくても商品は消さない。次回また試せるようにする
  it('API呼び出しが失敗しても落ちず、unknown を返す', async () => {
    const { openai } = fakeOpenAI(new Error('rate limited'))
    const result = await classifyProduct(openai, input)
    expect(result.verdict).toBe('unknown')
    expect(result.reason).toContain('判定に失敗')
  })
})
