// ---------------------------------------------------------------------------
// サイトごとのビジネスポリシー指定。
//
// ユーザー報告(2026-10-19): ビジネスポリシーはマーケットプレイスごとに別物
// なので、1つの名前を全サイトのCSVに書くと、そのサイトに存在しないポリシー名が
// 入ってしまう。
//
// ユーザー報告(2026-11-01): そのときの修正を出品CSV(/api/csv)にだけ入れ、
// Specifics-IN CSV(/api/csv/specifics)に入れ忘れていた。UK/AUの2ファイルを
// 出すと、UKのCSVにAUの配送ポリシー(3area excluded ver.)が入り、eBayに
// アップロードしても「ポリシーが適用されない」となっていた。
// 同じ取り残しが起きないよう、判定をここに置いて両方から使う。
// ---------------------------------------------------------------------------

export interface SitePolicies {
  shipping: string
  payment: string
  return: string
}

/** サイトごとのポリシー指定。読めない値は無視して、従来の単一指定に落とす */
export function parsePoliciesBySite(value: string | null): Record<string, SitePolicies> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as Record<string, Partial<SitePolicies>>
    const result: Record<string, SitePolicies> = {}
    for (const [site, policies] of Object.entries(parsed)) {
      const shipping = policies?.shipping?.trim()
      const payment = policies?.payment?.trim()
      const ret = policies?.return?.trim()
      if (shipping && payment && ret) result[site.toUpperCase()] = { shipping, payment, return: ret }
    }
    return result
  } catch {
    return {}
  }
}

/** そのサイトのポリシー。指定が無ければ単一指定にフォールバックする */
export function policiesForSite(
  bySite: Record<string, SitePolicies>,
  siteKey: string,
  fallback: SitePolicies,
): SitePolicies {
  return bySite[siteKey] ?? fallback
}
