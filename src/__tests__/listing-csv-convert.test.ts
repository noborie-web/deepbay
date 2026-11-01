import { describe, expect, it } from 'vitest'
import { convertListingCsv, parseCsvRows, toCsvLine } from '@/lib/listing-csv-convert'

// ユーザー要望(2026-11-01): miyabi-24(US)と akebono-32(UK)に同じ商品を出す際、
// specifics-in での白抜き・目視削除・AI生成・コンプライアンスチェックを2回
// 繰り返している。アカウントで変わるのは透かしだけなので、完成したCSVの
// 「アカウントによって変わる列」だけを差し替える。
// Title / Description / C:*(Item Specifics) / Category / PicURL は触らない。

const HEADER = [
  'Action(CC=Cp1252)', 'CustomLabel', 'StartPrice', 'ConditionID', 'Title', 'Description',
  'C:Brand', 'PicURL', 'Category', 'PaymentProfileName', 'ReturnProfileName',
  'ShippingProfileName', 'Currency', 'SiteID',
]

function csvOf(rows: string[][]): string {
  return [toCsvLine(HEADER), ...rows.map(toCsvLine)].join('\r\n') + '\r\n'
}

const ROW_A = [
  'Add', 'kakehashi_e421eac7_abb1_493e_bc35_244bcc8fbbe2', '404.97', '5000',
  'Rare Nintendo 64 Gauntlet Legends', '<div id="ai-generated-content">本文, カンマ入り</div>',
  'Nintendo', 'https://example.com/a1.jpg|https://example.com/a2.jpg', '139973',
  'eBay Payments', 'Returns Accepted,Buyer,60 Days,Money Back', 'USED 3area excluded ver.',
  'USD', 'US',
]

const OPTIONS = {
  siteId: 'UK',
  currency: 'GBP',
  policies: { payment: 'UK Payments', return: 'UK Returns', shipping: 'UK Shipping' },
  replacements: new Map([
    ['kakehashi_e421eac7_abb1_493e_bc35_244bcc8fbbe2', {
      customLabel: 'kakehashi_11111111_2222_3333_4444_555555555555',
      startPrice: 318.4567,
    }],
  ]),
}

describe('完成CSVを別セラー向けに変換する', () => {
  it('アカウントで変わる列だけ差し替え、AI生成の結果はそのまま残す', () => {
    const result = convertListingCsv(csvOf([ROW_A]), OPTIONS)
    expect(result.converted).toBe(1)
    expect(result.skipped).toEqual([])

    const rows = parseCsvRows(result.csv)
    const row = Object.fromEntries(rows[0].map((h, i) => [h, rows[1][i]]))

    // 差し替える列
    expect(row.CustomLabel).toBe('kakehashi_11111111_2222_3333_4444_555555555555')
    expect(row.StartPrice).toBe('318.46')
    expect(row.Currency).toBe('GBP')
    expect(row.SiteID).toBe('UK')
    expect(row.PaymentProfileName).toBe('UK Payments')
    expect(row.ReturnProfileName).toBe('UK Returns')
    expect(row.ShippingProfileName).toBe('UK Shipping')

    // ここが本題。作り直さない列はそのまま
    expect(row.Title).toBe('Rare Nintendo 64 Gauntlet Legends')
    expect(row.Description).toBe('<div id="ai-generated-content">本文, カンマ入り</div>')
    expect(row['C:Brand']).toBe('Nintendo')
    expect(row.Category).toBe('139973')
    expect(row.PicURL).toBe('https://example.com/a1.jpg|https://example.com/a2.jpg')
  })

  it('複製先に対応する商品が無い行は出力せず、理由を返す', () => {
    const unknown = [...ROW_A]
    unknown[1] = 'kakehashi_99999999_9999_9999_9999_999999999999'
    const result = convertListingCsv(csvOf([ROW_A, unknown]), OPTIONS)

    // 黙って元のCustomLabelのまま出すと、別アカウントの出品が同じ商品を指す
    expect(result.converted).toBe(1)
    expect(result.skipped).toEqual(['kakehashi_99999999_9999_9999_9999_999999999999'])
    expect(parseCsvRows(result.csv)).toHaveLength(2)
  })

  // 本番で確認した不具合(2026-11-01): BOMを落としたまま返していた。1列目が
  // Action(CC=Cp1252) なので、BOMが無いとeBayはCp1252として読もうとし、
  // 日本語を含むCSVは1件も処理されずに終わる。
  it('先頭にBOMを付けて返す(eBayがUTF-8と判別できるように)', () => {
    const result = convertListingCsv(csvOf([ROW_A]), OPTIONS)
    expect(result.csv.charCodeAt(0)).toBe(0xfeff)
    // BOMを付けても読み直せる
    expect(parseCsvRows(result.csv)[0][0]).toBe('Action(CC=Cp1252)')
  })

  it('CustomLabel 列が無いCSVは断る', () => {
    const csv = '"Title","StartPrice"\r\n"a","1"\r\n'
    expect(() => convertListingCsv(csv, OPTIONS)).toThrow(/CustomLabel/)
  })
})

describe('CSVの読み書き', () => {
  it('引用符の中のカンマ・改行・二重引用符を保つ', () => {
    const csv = '"a","b,c","d""e","f\ng"\r\n'
    expect(parseCsvRows(csv)).toEqual([['a', 'b,c', 'd"e', 'f\ng']])
  })

  it('先頭のBOMを落とす(列名が一致しなくなるため)', () => {
    expect(parseCsvRows('﻿"CustomLabel"\r\n')[0]).toEqual(['CustomLabel'])
  })

  it('最終行に改行が無くても取りこぼさない', () => {
    expect(parseCsvRows('"a"\r\n"b"')).toEqual([['a'], ['b']])
  })

  it('書き戻した値をもう一度読める', () => {
    const values = ['a', 'b,c', 'd"e', 'f\ng']
    expect(parseCsvRows(toCsvLine(values))).toEqual([values])
  })
})
