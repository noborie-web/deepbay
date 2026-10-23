import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// 「黙って0件になる」書き方を数える。
//
// 本番で繰り返し起きた事故は、原因こそ違うが形はすべて同じだった:
// **失敗が「0件」として返り、正常な0件と区別できないまま処理が進む。**
//
//   2026-09-22 価格改定が1件も実行されない   (.in()が400 → errorを見ていない)
//   2026-10-08 在庫数不明の84件が未チェック  (null > 0 が偽)
//   2026-10-09 出品中の626件を削除           (安全装置が素通り)
//   2026-10-20 価格改定が2,091件中0件        (1,000行上限 + .in()が400)
//   2026-10-22 akebono-32の479件が3日間停止  (時間切れ → 0件取得 → completed)
//   2026-10-22 内訳が2,087件→1,000件に化ける (1,000行上限)
//
// 呼び出し箇所を1つずつ直しても、機能を足すたびに新しい箇所が増えるので
// 収束しない。ここでは「現状より悪化しないこと」だけを機械的に保証する
// (ラチェット)。既存分はallowlistに積んであり、減らす方向にしか更新できない。
// ---------------------------------------------------------------------------

/** 1,000行を超えうるテーブル。小さい設定テーブルは上限に当たらないので対象外 */
export const LARGE_TABLES = [
  'products',
  'inventory_active_listings',
  'extractions',
  'ebay_categories',
  'ebay_api_calls',
] as const

export type Finding =
  /** .in() に件数の読めない配列を渡している (URLが長すぎると400になる) */
  | 'unbounded_in'
  /** 大きいテーブルを件数上限なしで引いている (既定1,000行で黙って切られる) */
  | 'unbounded_select'
  /** error を受け取っていない (失敗が0件と区別できない) */
  | 'ignored_error'

export type AuditCounts = Record<string, Partial<Record<Finding, number>>>

/**
 * 誤検知を黙って数え続けるとラチェットが信用されなくなるので、理由付きで
 * 明示的に外せるようにする。該当行か直前の行に次を書く:
 *   // db-audit-ok: 件数は batchLimit(40) に収まる
 * 理由が空のものは外さない(「とりあえず黙らせる」を防ぐ)。
 */
const SUPPRESS = /\/\/\s*db-audit-ok:\s*\S/

function isSuppressed(lines: string[], lineIndex: number): boolean {
  return SUPPRESS.test(lines[lineIndex] ?? '') || SUPPRESS.test(lines[lineIndex - 1] ?? '')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') walk(path, out)
    } else if (/\.tsx?$/.test(path)) out.push(path)
  }
  return out
}

/** .in() に渡す配列の件数が読めるか(読めれば400にならず、結果も上限内) */
function isBoundedIdList(arg: string): boolean {
  return arg.startsWith('[') || /chunk/i.test(arg) || /\.slice\(/.test(arg)
}

function add(counts: AuditCounts, file: string, kind: Finding) {
  const row = (counts[file] ??= {})
  row[kind] = (row[kind] ?? 0) + 1
}

export function auditDbQueries(root = 'src'): AuditCounts {
  const counts: AuditCounts = {}
  // db-chunk.ts は分割・ページ送りを引き受ける側なので対象外
  const files = walk(root).filter(file => !file.endsWith('db-chunk.ts'))

  for (const file of files) {
    const src = readFileSync(file, 'utf8')

    const lines = src.split('\n')
    for (const [index, line] of lines.entries()) {
      if (/^\s*(\/\/|\*)/.test(line)) continue
      if (isSuppressed(lines, index)) continue
      const inCall = line.match(/\.in\(\s*['"][^'"]+['"]\s*,\s*(.+?)\)\s*$/)
      if (inCall) {
        // 固定の配列リテラル・分割済み(chunk / slice)は件数が読めるので安全。
        // 変数名は sourceLookupKeyChunk のように複合語になるので部分一致で見る。
        if (!isBoundedIdList(inCall[1].trim())) add(counts, file, 'unbounded_in')
      }
      // const { data } = await ... : error を捨てている
      if (/const\s*\{\s*data[^}]*\}\s*=\s*await/.test(line) && !/error/.test(line)) {
        add(counts, file, 'ignored_error')
      }
    }

    const chain = /\.from\(\s*['"]([a-z_]+)['"]\s*\)([\s\S]{0,700}?)(?=\n\s*\n|\n\s*(?:const|let|if|return|\}|\/\/))/g
    let match: RegExpExecArray | null
    while ((match = chain.exec(src))) {
      const [, table, body] = match
      // selectAllRows(() => db.from(...)) のように包む書き方は、ヘルパー名が
      // .from( より**前**に出る。直前も見ないと、直した箇所を危険と数え続け、
      // ベースラインが0に向かわない。
      // 文の先頭(直前の空行)まで遡って探す。型引数が長いと固定幅では届かない。
      const head = src.lastIndexOf('\n\n', match.index)
      const before = src.slice(head === -1 ? Math.max(0, match.index - 600) : head, match.index)
      if (/selectAllRows|selectByIds|selectInChunks/.test(before)) continue
      if (!(LARGE_TABLES as readonly string[]).includes(table)) continue
      if (!/\.select\(/.test(body)) continue
      if (/\.(range|limit|single|maybeSingle)\(/.test(body)) continue
      if (/head:\s*true/.test(body)) continue
      if (/\.(insert|update|upsert|delete)\(/.test(body)) continue
      if (/selectAllRows|selectByIds/.test(body)) continue
      // 分割済みの .in(..., chunk) で絞っている取得は、その時点で100件以下に
      // なるので1,000行の上限には当たらない。
      const inArg = body.match(/\.in\(\s*['"][^'"]+['"]\s*,\s*(.+?)\)/)
      if (inArg && isBoundedIdList(inArg[1].trim())) continue
      // 抑制コメントは文の頭に書かれることが多いので、ヘルパー判定と同じ
      // 範囲(文の先頭〜.from まで)を見る。行単位だと2行上に書かれて届かない。
      if (SUPPRESS.test(before)) continue
      add(counts, file, 'unbounded_select')
    }
  }
  return counts
}

export function totalFindings(counts: AuditCounts): number {
  return Object.values(counts).reduce(
    (sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0),
    0,
  )
}
