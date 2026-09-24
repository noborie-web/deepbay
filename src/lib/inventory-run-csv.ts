// 実行履歴(inventory_runs)の result_summary.items から、公式ツールと同じ形式の
// CSVを組み立てる(価格追従=revise / 差分検知=diff / 取り下げ=end_items)。

export interface RunRecord {
  id: string
  run_type: string
  started_at: string
  result_summary: Record<string, unknown> | null
}

export interface BuiltCsv { csv: string; filename: string; rows: number }

function csvLine(values: Array<string | number | null | undefined>): string {
  return values.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
}

function dateStamp(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '')
}

type SupplierItem = {
  ebay_item_id: string; source_url: string | null; outcome: string; title_changed: boolean; reserved: boolean
  old_title: string | null; new_title: string | null
  purchase_price_before: number | null; purchase_price_after: number | null
  ebay_price_before: number | null; ebay_price_after: number | null
}
type ReviseItem = { ebay_item_id: string; price_before: number | null; price_after: number | null; diff: number | null; success: boolean }
type DelistItem = { ebay_item_id: string; action: string; reason: string; success: boolean }

function items<T>(summary: Record<string, unknown> | null): T[] {
  return Array.isArray(summary?.items) ? (summary!.items as T[]) : []
}

// 実行タイプごとに出力できるCSVの種類
export function availableRunCsvKinds(run: RunRecord): Array<{ kind: string; label: string; count: number }> {
  const summary = run.result_summary
  if (run.run_type === 'supplier_check' || run.run_type === 'flea_check' || run.run_type === 'supplier_quick_check') {
    const list = items<SupplierItem>(summary)
    const revise = list.filter(i => i.ebay_price_after !== null && i.ebay_price_before !== null).length
    const diff = list.filter(i => i.title_changed || i.reserved || (i.purchase_price_after !== null && i.purchase_price_before !== null && i.purchase_price_after !== i.purchase_price_before)).length
    const delist = list.filter(i => i.outcome === 'unavailable').length
    return [
      { kind: 'revise', label: '価格追従', count: revise },
      { kind: 'diff', label: '差分検知', count: diff },
      { kind: 'end_items', label: '取り下げ対象', count: delist },
    ].filter(k => k.count > 0)
  }
  if (run.run_type === 'auto_revise_price' || run.run_type === 'revise_price') {
    const n = items<ReviseItem>(summary).length
    return n > 0 ? [{ kind: 'revise', label: '価格改定', count: n }] : []
  }
  if (run.run_type === 'auto_delist' || run.run_type === 'delist') {
    const n = items<DelistItem>(summary).length
    return n > 0 ? [{ kind: 'end_items', label: '取り下げ', count: n }] : []
  }
  return []
}

export function buildRunCsv(run: RunRecord, kind: string, seller: string): BuiltCsv | null {
  const summary = run.result_summary
  const stamp = dateStamp(run.started_at)
  const kinds = availableRunCsvKinds(run)
  const resolved = kind === 'auto' ? kinds[0]?.kind : kind
  if (!resolved || !kinds.some(k => k.kind === resolved)) return null

  if (run.run_type === 'supplier_check' || run.run_type === 'flea_check' || run.run_type === 'supplier_quick_check') {
    const list = items<SupplierItem>(summary)
    if (resolved === 'revise') {
      const rows = list
        .filter(i => i.ebay_price_after !== null && i.ebay_price_before !== null)
        .map(i => csvLine(['Revise', i.ebay_item_id, i.ebay_price_after, i.ebay_price_before, Math.round(((i.ebay_price_after ?? 0) - (i.ebay_price_before ?? 0)) * 100) / 100]))
      return { csv: [csvLine(['#INFO', 'col1', 'col2', 'col3', 'col4']), csvLine(['Action', 'Item number', 'Start price', '変更前価格', '変更価格差分']), ...rows].join('\n'), filename: `${seller}_revise_${stamp}.csv`, rows: rows.length }
    }
    if (resolved === 'diff') {
      const rows = list
        .filter(i => i.title_changed || i.reserved || (i.purchase_price_after !== null && i.purchase_price_before !== null && i.purchase_price_after !== i.purchase_price_before))
        .map(i => {
          const diffs: string[] = []
          if (i.title_changed) diffs.push('title')
          if (i.reserved) diffs.push('reserved')
          if (i.purchase_price_after !== null && i.purchase_price_before !== null && i.purchase_price_after !== i.purchase_price_before) diffs.push('price')
          return csvLine([i.ebay_item_id, i.source_url, i.old_title, i.new_title ?? i.old_title, i.purchase_price_before, i.purchase_price_after ?? i.purchase_price_before, JSON.stringify(diffs)])
        })
      return { csv: [csvLine(['1_item_id', '2_url', '3_旧タイトル', '4_最新タイトル', '5_旧価格', '6_最新価格', 'diff_detail']), ...rows].join('\n'), filename: `${seller}_diff_${stamp}.csv`, rows: rows.length }
    }
    if (resolved === 'end_items') {
      const rows = list.filter(i => i.outcome === 'unavailable').map(i => csvLine(['Revise', i.ebay_item_id, '0', '', i.reserved ? 'reserved' : 'sold_out']))
      return { csv: [csvLine(['#INFO', 'col1', 'col2', 'col3', 'col4']), csvLine(['Action', 'Item number', 'Available quantity', 'EndCode', 'reason']), ...rows].join('\n'), filename: `${seller}_end_items_${stamp}.csv`, rows: rows.length }
    }
    return null
  }

  if (resolved === 'revise') {
    const rows = items<ReviseItem>(summary).map(i => csvLine(['Revise', i.ebay_item_id, i.price_after, i.price_before, i.diff, i.success ? '' : 'failed']))
    return { csv: [csvLine(['#INFO', 'col1', 'col2', 'col3', 'col4', 'col5']), csvLine(['Action', 'Item number', 'Start price', '変更前価格', '変更価格差分', 'result']), ...rows].join('\n'), filename: `${seller}_revise_${stamp}.csv`, rows: rows.length }
  }
  if (resolved === 'end_items') {
    const rows = items<DelistItem>(summary).map(i => csvLine([i.action, i.ebay_item_id, i.action === 'Revise' ? '0' : '', i.action === 'End' ? 'NotAvailable' : '', i.reason, i.success ? '' : 'failed']))
    return { csv: [csvLine(['#INFO', 'col1', 'col2', 'col3', 'col4', 'col5']), csvLine(['Action', 'Item number', 'Available quantity', 'EndCode', 'reason', 'result']), ...rows].join('\n'), filename: `${seller}_end_items_${stamp}.csv`, rows: rows.length }
  }
  return null
}

// 実行履歴の一覧に出す短い要約
export function summarizeRun(run: RunRecord): string {
  const s = run.result_summary ?? {}
  const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null)
  switch (run.run_type) {
    case 'sync': return [
      n('discovered') ? `新規発見 ${n('discovered')}件` : null,
      n('ended') ? `終了 ${n('ended')}件` : null,
      n('remaining') ? `残り ${n('remaining')}件は次回` : null,
    ].filter(Boolean).join(' / ')
    case 'supplier_check': case 'flea_check': case 'supplier_quick_check': return [
      `確認 ${n('total') ?? 0}件`, `売り切れ ${n('unavailable') ?? 0}件`, `価格追従 ${n('price_recalculated') ?? 0}件`, `タイトル変更 ${n('title_changed') ?? 0}件`,
      n('no_supplier') ? `仕入先なし ${n('no_supplier')}件` : null, n('skipped') ? `未確認 ${n('skipped')}件` : null,
      n('rate_limited') ? `アクセス制限 ${n('rate_limited')}件` : null,
    ].filter(Boolean).join(' / ')
    case 'auto_delist': case 'delist': return `取り下げ ${n('succeeded') ?? 0}/${n('total') ?? 0}件`
    case 'undo_delist': return `在庫を戻した ${n('succeeded') ?? 0}/${n('total') ?? 0}件`
    case 'auto_revise_price': case 'revise_price': return `価格改定 ${n('succeeded') ?? 0}/${n('total') ?? 0}件${n('deferred') ? `（翌日持ち越し ${n('deferred')}件）` : ''}`
    case 'auto_stack': case 'stack': return `積み上げ ${n('succeeded') ?? 0}/${n('total') ?? 0}件`
    default: return ''
  }
}

export const RUN_TYPE_LABELS: Record<string, string> = {
  sync: 'eBay同期',
  upload: 'CSVアップロード',
  supplier_check: '仕入先チェック',
  auto_delist: '取り下げ（自動）',
  delist: '取り下げ',
  auto_revise_price: '価格改定（自動）',
  revise_price: '価格改定',
  auto_stack: '積み上げ（自動）',
  stack: '積み上げ',
  translate_descriptions: '説明文の英訳',
  undo_delist: '取り下げの取り消し',
  flea_check: 'Yahoo!フリマ在庫チェック',
  supplier_quick_check: '仕入先チェック（15分ごと）',
}
