import { describe, expect, it } from 'vitest'
import { availableRunCsvKinds, buildRunCsv, summarizeRun } from '../lib/inventory-run-csv'

// ユーザー要望: 公式ツールのように、価格追従・差分検知・取り下げの結果を実行ごとに
// CSV(revise / diff / end_items 形式)で出力する。
describe('inventory-run-csv', () => {
  const supplierRun = {
    id: 'run-1', run_type: 'supplier_check', started_at: '2026-09-21T00:37:00.000Z',
    result_summary: {
      total: 3, unavailable: 1, price_recalculated: 1, title_changed: 1,
      items: [
        { ebay_item_id: '111', source_url: 'https://jp.mercari.com/item/m1', outcome: 'available', title_changed: false, reserved: false, old_title: 'A', new_title: 'A', purchase_price_before: 5000, purchase_price_after: 5500, ebay_price_before: 135.14, ebay_price_after: 140.2 },
        { ebay_item_id: '222', source_url: 'https://jp.mercari.com/item/m2', outcome: 'available', title_changed: true, reserved: false, old_title: 'B', new_title: 'B 値下げ', purchase_price_before: 3000, purchase_price_after: 3000, ebay_price_before: null, ebay_price_after: null },
        { ebay_item_id: '333', source_url: 'https://jp.mercari.com/item/m3', outcome: 'unavailable', title_changed: false, reserved: false, old_title: 'C', new_title: null, purchase_price_before: 4000, purchase_price_after: null, ebay_price_before: null, ebay_price_after: null },
      ],
    },
  }

  it('仕入先チェックの実行から 価格追従 / 差分検知 / 取り下げ対象 のCSVを出せる', () => {
    expect(availableRunCsvKinds(supplierRun)).toEqual([
      { kind: 'revise', label: '価格追従', count: 1 },
      { kind: 'diff', label: '差分検知', count: 2 },
      { kind: 'end_items', label: '取り下げ対象', count: 1 },
    ])

    const revise = buildRunCsv(supplierRun, 'revise', 'miyabi-24')!
    expect(revise.filename).toBe('miyabi-24_revise_20260921.csv')
    expect(revise.csv.split('\n')).toEqual([
      '"#INFO","col1","col2","col3","col4"',
      '"Action","Item number","Start price","変更前価格","変更価格差分"',
      '"Revise","111","140.2","135.14","5.06"',
    ])

    const diff = buildRunCsv(supplierRun, 'diff', 'miyabi-24')!
    expect(diff.csv.split('\n')[0]).toBe('"1_item_id","2_url","3_旧タイトル","4_最新タイトル","5_旧価格","6_最新価格","diff_detail"')
    expect(diff.csv.split('\n')[1]).toBe('"111","https://jp.mercari.com/item/m1","A","A","5000","5500","[""price""]"')
    expect(diff.csv.split('\n')[2]).toBe('"222","https://jp.mercari.com/item/m2","B","B 値下げ","3000","3000","[""title""]"')

    const end = buildRunCsv(supplierRun, 'end_items', 'miyabi-24')!
    expect(end.csv.split('\n')[2]).toBe('"Revise","333","0","","sold_out"')
  })

  it('価格改定・取り下げの実行からもCSVを出せ、結果の無い実行は出さない', () => {
    const revise = { id: 'r', run_type: 'auto_revise_price', started_at: '2026-09-21T00:41:00.000Z', result_summary: { total: 1, succeeded: 1, items: [{ ebay_item_id: '111', price_before: 100, price_after: 110.5, diff: 10.5, success: true }] } }
    expect(buildRunCsv(revise, 'auto', 'u')!.csv.split('\n')[2]).toBe('"Revise","111","110.5","100","10.5",""')
    const delist = { id: 'd', run_type: 'auto_delist', started_at: '2026-09-21T00:40:00.000Z', result_summary: { total: 1, succeeded: 0, items: [{ ebay_item_id: '222', action: 'Revise', reason: 'sold_out', success: false }] } }
    expect(buildRunCsv(delist, 'auto', 'u')!.csv.split('\n')[2]).toBe('"Revise","222","0","","sold_out","failed"')
    expect(buildRunCsv({ id: 's', run_type: 'sync', started_at: '2026-09-21T00:00:00.000Z', result_summary: null }, 'auto', 'u')).toBeNull()
  })

  it('実行履歴の要約文を作る', () => {
    expect(summarizeRun(supplierRun)).toBe('確認 3件 / 売り切れ 1件 / 価格追従 1件 / タイトル変更 1件')
    expect(summarizeRun({ id: 'r', run_type: 'auto_revise_price', started_at: '', result_summary: { total: 110, succeeded: 62, deferred: 48 } })).toBe('価格改定 62/110件（翌日持ち越し 48件）')
  })
})
