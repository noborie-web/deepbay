import { EBAY_SITES, EBAY_SITE_KEYS, type EbaySiteKey } from './ebay-sites'

// ---------------------------------------------------------------------------
// 価格改定・取り下げのCSV出力（eBay File Exchange 用）
//
// ユーザー要望(2026-09-27): APIの呼び出し上限に達すると価格改定も取り下げも
// 実行できなくなる。CSVを出してeBayにアップロードすれば、Kakehashiの
// API枠を使わずに反映できる（実行前に内容を確認できる利点もある）。
//
// サイト(US/UK/AU)ごとに SiteID・Currency が変わるため、出品CSVと同じく
// サイトごとに1ファイルずつ出力する。
// ---------------------------------------------------------------------------

export interface ReviseCsvRow {
  ebayItemId: string
  price: number
  siteId: string | null
}

export interface EndCsvRow {
  ebayItemId: string
  siteId: string | null
}

export interface BuiltActionCsv {
  site: EbaySiteKey
  filename: string
  csv: string
  rows: number
}

function escapeCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function line(values: Array<string | number>): string {
  return values.map(v => escapeCsv(String(v))).join(',')
}

function siteKeyOf(siteId: string | null | undefined): EbaySiteKey {
  const upper = (siteId ?? 'US').toUpperCase()
  return EBAY_SITE_KEYS.find(key => EBAY_SITES[key].siteId === upper) ?? 'US'
}

function dateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '')
}

function filenameFor(seller: string, kind: 'revise' | 'end', site: EbaySiteKey, multiSite: boolean, now?: Date): string {
  const safeSeller = seller.replace(/[^A-Za-z0-9._-]/g, '_') || 'seller'
  return [safeSeller, ...(multiSite ? [site] : []), kind, dateStamp(now)].join('_') + '.csv'
}

function groupBySite<T extends { siteId: string | null }>(rows: T[]): Map<EbaySiteKey, T[]> {
  const groups = new Map<EbaySiteKey, T[]>()
  for (const row of rows) {
    const key = siteKeyOf(row.siteId)
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  return groups
}

/**
 * 価格改定CSV。アップロードするとその価格に更新される。
 */
export function buildReviseCsvFiles(rows: ReviseCsvRow[], seller: string, now?: Date): BuiltActionCsv[] {
  const groups = groupBySite(rows)
  const multiSite = groups.size > 1
  return Array.from(groups.entries()).map(([site, siteRows]) => {
    const { siteId, currency } = EBAY_SITES[site]
    const header = line(['Action(CC=Cp1252)', 'ItemID', 'StartPrice', 'Currency', 'SiteID'])
    const body = siteRows.map(row => line(['Revise', row.ebayItemId, row.price.toFixed(2), currency, siteId]))
    return {
      site,
      filename: filenameFor(seller, 'revise', site, multiSite, now),
      csv: `﻿${[header, ...body].join('\r\n')}`,
      rows: body.length,
    }
  })
}

/**
 * 取り下げCSV。アップロードすると出品が終了する(End)。
 */
export function buildEndCsvFiles(rows: EndCsvRow[], seller: string, now?: Date): BuiltActionCsv[] {
  const groups = groupBySite(rows)
  const multiSite = groups.size > 1
  return Array.from(groups.entries()).map(([site, siteRows]) => {
    const { siteId, currency } = EBAY_SITES[site]
    const header = line(['Action(CC=Cp1252)', 'ItemID', 'EndCode', 'Currency', 'SiteID'])
    // NotAvailable: 商品が用意できなくなったため終了(仕入先の売り切れ)
    const body = siteRows.map(row => line(['End', row.ebayItemId, 'NotAvailable', currency, siteId]))
    return {
      site,
      filename: filenameFor(seller, 'end', site, multiSite, now),
      csv: `﻿${[header, ...body].join('\r\n')}`,
      rows: body.length,
    }
  })
}
