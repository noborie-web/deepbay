import { describe, expect, it } from 'vitest'
import { buildDangerSettingsCsv } from '@/lib/extraction-settings-csv'

describe('抽出危険設定CSV', () => {
  it('現在の危険セラーをUTF-8 BOM付きで出力する', () => {
    const file = buildDangerSettingsCsv('sellers', {
      sellers: [
        { seller_url: 'https://jp.mercari.com/user/profile/123' },
        { seller_url: 'https://jp.mercari.com/user/profile/456' },
      ],
    })

    expect(file.filename).toBe('danger_sellers.csv')
    expect(file.count).toBe(2)
    expect(file.content).toBe(
      '\uFEFFseller_url\r\n"https://jp.mercari.com/user/profile/123"\r\n"https://jp.mercari.com/user/profile/456"',
    )
  })

  it('現在の危険単語を引用符を保護して出力する', () => {
    const file = buildDangerSettingsCsv('words', {
      words: [{ word: 'Nintendo' }, { word: 'He said "test"' }],
    })

    expect(file.filename).toBe('danger_words.csv')
    expect(file.count).toBe(2)
    expect(file.content).toContain('"Nintendo"')
    expect(file.content).toContain('"He said ""test"""')
  })

  it('現在の置換単語を2列で出力する', () => {
    const file = buildDangerSettingsCsv('replaces', {
      replaces: [{ before_word: '置換前', after_word: '置換後' }],
    })

    expect(file.filename).toBe('replace_words.csv')
    expect(file.count).toBe(1)
    expect(file.content).toBe('\uFEFFbefore_word,after_word\r\n"置換前","置換後"')
  })
})
