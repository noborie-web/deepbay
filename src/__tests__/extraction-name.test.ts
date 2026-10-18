import { describe, expect, it } from 'vitest'
import { buildExtractionName } from '@/lib/extraction-name'

// ユーザー要望(2026-10-15): 抽出リスト名を自動で入れたい。
// 抽出が増えると一覧で「どのURLの抽出だったか」が分からなくなるため。

describe('buildExtractionName', () => {
  it('ヤフオクのキーワード検索は検索語を使う', () => {
    expect(buildExtractionName('https://auctions.yahoo.co.jp/search/search?p=%E3%82%A2%E3%83%96%E3%82%AC%E3%83%AB%E3%82%B7%E3%82%A2&b=1'))
      .toBe('アブガルシア')
  })

  it('検索語の + は空白に直す', () => {
    expect(buildExtractionName('https://auctions.yahoo.co.jp/search/search?p=casio+watch'))
      .toBe('casio watch')
  })

  it('メルカリのキーワード検索も拾う', () => {
    expect(buildExtractionName('https://jp.mercari.com/search?keyword=%E3%82%AE%E3%82%BF%E3%83%BC'))
      .toBe('ギター')
  })

  // カテゴリ検索にはキーワードが無いので、商品のカテゴリ名を使う
  it('カテゴリ検索は商品カテゴリで一番多いものを使う', () => {
    expect(buildExtractionName(
      'https://auctions.yahoo.co.jp/category/list/2084064354?auccat=2084064354',
      [{ category: 'アブガルシア' }, { category: 'アブガルシア' }, { category: 'シマノ' }],
    )).toBe('アブガルシア')
  })

  // ユーザー要望(2026-10-18): 「ダイワ」だけでなく「ダイワ スピニングリール」の
  // ように分かる名前にしたい。末尾の名前だけでは意味をなさないことがある
  // (本番で確認: ファミコン > 「タイトル」という実在のカテゴリ)。
  it('カテゴリの階層があれば末尾2つを使う', () => {
    const path = ['スポーツ、レジャー', 'フィッシング', 'リール', 'スピニングリール', 'ダイワ']
    expect(buildExtractionName(
      'https://auctions.yahoo.co.jp/category/list/2084064356?auccat=2084064356',
      [{ category: 'ダイワ', categoryPath: path }, { category: 'ダイワ', categoryPath: path }],
    )).toBe('ダイワ スピニングリール')
  })

  it('末尾の名前だけでは意味をなさないカテゴリでも親が付く', () => {
    const path = ['おもちゃ、ゲーム', 'ゲーム', 'テレビゲーム', 'ファミコン', 'タイトル']
    expect(buildExtractionName(
      'https://auctions.yahoo.co.jp/category/list/2084005190?auccat=2084005190',
      [{ category: 'アクション', categoryPath: path }],
    )).toBe('タイトル ファミコン')
  })

  it('親と末尾が重なる場合は繰り返さない', () => {
    expect(buildExtractionName('https://auctions.yahoo.co.jp/category/list/1?auccat=1',
      [{ categoryPath: ['リール', 'スピニングリール'] }])).toBe('スピニングリール')
  })

  it('階層が1つだけならそれを使う', () => {
    expect(buildExtractionName('https://auctions.yahoo.co.jp/category/list/1?auccat=1',
      [{ categoryPath: ['ダイワ'] }])).toBe('ダイワ')
  })

  it('階層が無ければ従来どおりカテゴリ名を使う', () => {
    expect(buildExtractionName('https://auctions.yahoo.co.jp/category/list/1?auccat=1',
      [{ category: 'ダイワ' }])).toBe('ダイワ')
  })

  it('キーワードがあればカテゴリより優先する', () => {
    expect(buildExtractionName(
      'https://auctions.yahoo.co.jp/search/search?p=reel',
      [{ category: 'アブガルシア' }],
    )).toBe('reel')
  })

  it('ASIN指定のAmazon抽出は件数を入れる（元URLが無いため）', () => {
    expect(buildExtractionName('amazon:asin-list:317', [])).toBe('Amazon ASIN 317件')
  })

  // 中身の無い名前を付けるくらいなら何も入れない
  it('手がかりが無ければnull（「不明」等を入れない）', () => {
    expect(buildExtractionName('https://example.com/list', [])).toBeNull()
    expect(buildExtractionName('https://auctions.yahoo.co.jp/category/list/123', [{ category: null }])).toBeNull()
  })

  it('空のキーワードは使わない', () => {
    expect(buildExtractionName('https://jp.mercari.com/search?keyword=&category_id=5', [])).toBeNull()
  })

  it('長すぎる名前は切り詰める', () => {
    const name = buildExtractionName(`https://jp.mercari.com/search?keyword=${'あ'.repeat(80)}`)
    expect(name!.length).toBeLessThanOrEqual(40)
    expect(name!.endsWith('…')).toBe(true)
  })

  it('URLでない入力でも落ちない', () => {
    expect(buildExtractionName('not a url', [])).toBeNull()
    expect(buildExtractionName('', [])).toBeNull()
  })
})
