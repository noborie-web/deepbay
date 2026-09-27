import { describe, expect, it } from 'vitest'
import { buildEndCsvFiles, buildReviseCsvFiles } from '@/lib/inventory-action-csv'

// ユーザー要望(2026-09-27): APIの呼び出し上限に達しても運用できるよう、
// 価格改定・取り下げをCSVで出力してeBayにアップロードできるようにする。
const NOW = new Date('2026-09-27T12:00:00Z')

describe('価格改定CSV', () => {
  it('US出品はUSD・SiteID=USで出力する', () => {
    const [file] = buildReviseCsvFiles(
      [{ ebayItemId: '111', price: 110, siteId: 'US' }],
      'miyabi-24',
      NOW,
    )
    expect(file.filename).toBe('miyabi-24_revise_20260927.csv')
    expect(file.rows).toBe(1)
    expect(file.csv).toContain('Action(CC=Cp1252),ItemID,StartPrice,Currency,SiteID')
    expect(file.csv).toContain('Revise,111,110.00,USD,US')
  })

  it('サイトが混ざる場合はサイトごとにファイルを分け、ファイル名にサイトを入れる', () => {
    const files = buildReviseCsvFiles([
      { ebayItemId: '111', price: 110, siteId: 'US' },
      { ebayItemId: '222', price: 82.24, siteId: 'UK' },
      { ebayItemId: '333', price: 154.85, siteId: 'AU' },
    ], 'akebono-32', NOW)

    expect(files.map(f => f.site).sort()).toEqual(['AU', 'UK', 'US'])
    const uk = files.find(f => f.site === 'UK')!
    expect(uk.filename).toBe('akebono-32_UK_revise_20260927.csv')
    expect(uk.csv).toContain('Revise,222,82.24,GBP,UK')
    const au = files.find(f => f.site === 'AU')!
    expect(au.csv).toContain('Revise,333,154.85,AUD,AU')
  })
})

describe('取り下げCSV', () => {
  it('End(NotAvailable)で出力する', () => {
    const [file] = buildEndCsvFiles([{ ebayItemId: '444', siteId: 'UK' }], 'akebono-32', NOW)
    expect(file.filename).toBe('akebono-32_end_20260927.csv')
    expect(file.csv).toContain('Action(CC=Cp1252),ItemID,EndCode,Currency,SiteID')
    expect(file.csv).toContain('End,444,NotAvailable,GBP,UK')
  })

  it('サイト未設定はUSとして扱う', () => {
    const [file] = buildEndCsvFiles([{ ebayItemId: '555', siteId: null }], 'miyabi-24', NOW)
    expect(file.site).toBe('US')
    expect(file.csv).toContain('End,555,NotAvailable,USD,US')
  })
})
