import { describe, expect, it } from 'vitest'
import { parseEbayActiveListingsCsv } from '@/lib/inventory'

// 本番で発生した事故(2026-10-08): Seller HubのCSVを取り込んだら1,935件中0件
// マッチになり、既存の在庫管理(895件)が消えた。列名の照合が「trimして完全
// 一致・大文字小文字も区別」だったため、少しの表記違いで列を見失っていた。
const ROW = '377535920770,kakehashi_9ef13534_4516_4002_ae6e_defdf80b4d54,Rare CD,155.71,1,0'

function parseWith(header: string) {
  return parseEbayActiveListingsCsv([header, ROW].join('\n'))
}

describe('CSVの列名の表記ゆれ', () => {
  const expected = {
    ebayItemId: '377535920770',
    customLabel: 'kakehashi_9ef13534_4516_4002_ae6e_defdf80b4d54',
    title: 'Rare CD',
    currentPrice: 155.71,
    quantity: 1,
    quantitySold: 0,
  }

  it('標準の列名を読める', () => {
    const [listing] = parseWith('Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity')
    expect(listing).toMatchObject(expected)
  })

  it('大文字小文字の違いを吸収する', () => {
    const [listing] = parseWith('ITEM NUMBER,Custom Label (SKU),TITLE,Current Price,Available Quantity,Sold Quantity')
    expect(listing).toMatchObject(expected)
  })

  it('先頭のBOMがあっても最初の列を見失わない', () => {
    const [listing] = parseWith('﻿Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity')
    expect(listing?.ebayItemId).toBe('377535920770')
  })

  it('括弧やアンダースコアの違いを吸収する', () => {
    const [listing] = parseWith('Item_number,Custom label SKU,Title,Current price,Available quantity,Sold quantity')
    expect(listing).toMatchObject(expected)
  })

  it('列名が余分な空白を含んでも読める', () => {
    const [listing] = parseWith(' Item number , Custom label (SKU) , Title , Current price , Available quantity , Sold quantity ')
    expect(listing).toMatchObject(expected)
  })

  it('対応表にない列は無視して、既知の列だけ読む', () => {
    const [listing] = parseWith('Item number,Custom label (SKU),Title,Current price,Available quantity,Sold quantity')
    expect(listing?.customLabel).toBe(expected.customLabel)
  })
})
