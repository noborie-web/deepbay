import type { ScrapedProduct } from '@/lib/scrapers/types'

// ユーザー要望(2026-10-15): 抽出リスト名を自動で入れたい。
// 抽出が増えると、一覧で「どのURLの抽出だったか」が分からなくなるため。
//
// 名前の決め方は「人が見て思い出せるもの」を優先する:
//   1. 検索キーワード(URLの p / keyword / q / k)
//   2. カテゴリの階層の末尾2つ(カテゴリ検索ではキーワードが無いため)
//   3. ASIN指定のAmazon抽出は件数
// どれも取れなければ null を返し、何も入れない
// (「不明」のような中身の無い名前を付けない)。

const KEYWORD_PARAMS = ['p', 'keyword', 'q', 'k', 'field-keywords'] as const
const MAX_NAME_LENGTH = 40

export function buildExtractionName(
  url: string,
  products: Array<{ category?: ScrapedProduct['category']; categoryPath?: string[] }> = [],
): string | null {
  const keyword = keywordFromUrl(url)
  if (keyword) return truncate(keyword)

  const category = categoryNameFromProducts(products)
  if (category) return truncate(category)

  // ASIN指定のAmazon抽出(amazon:asin-list:317)には元URLが無い
  const asinCount = url.match(/^amazon:asin-list:(\d+)$/)?.[1]
  if (asinCount) return `Amazon ASIN ${Number(asinCount).toLocaleString()}件`

  return null
}

function keywordFromUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return null
  }
  for (const key of KEYWORD_PARAMS) {
    const raw = params.get(key)
    if (!raw) continue
    // 検索URLでは空白が + で入ることがある
    const value = raw.replace(/\+/g, ' ').trim()
    if (value) return value
  }
  return null
}

/**
 * カテゴリから名前を作る。
 *
 * 末尾の名前だけでは意味をなさないことがある(例: ファミコン > 「タイトル」)。
 * 階層が取れていれば末尾2つを「末尾 親」の順に並べて
 * 「ダイワ スピニングリール」のようにする。
 */
function categoryNameFromProducts(
  products: Array<{ category?: ScrapedProduct['category']; categoryPath?: string[] }>,
): string | null {
  const path = mostCommonCategoryPath(products)
  if (path && path.length > 0) {
    const leaf = path[path.length - 1]
    const parent = path.length >= 2 ? path[path.length - 2] : null
    // 「リール リール」のような重なりは避ける
    if (parent && !leaf.includes(parent) && !parent.includes(leaf)) return `${leaf} ${parent}`
    return leaf
  }
  return mostCommonCategory(products)
}

function mostCommonCategoryPath(
  products: Array<{ categoryPath?: string[] }>,
): string[] | null {
  const counts = new Map<string, { path: string[]; count: number }>()
  for (const product of products) {
    const path = (product.categoryPath ?? []).map((name) => name.trim()).filter(Boolean)
    if (path.length === 0) continue
    const key = path.join(' > ')
    const entry = counts.get(key) ?? { path, count: 0 }
    entry.count += 1
    counts.set(key, entry)
  }
  let best: string[] | null = null
  let bestCount = 0
  for (const entry of counts.values()) {
    if (entry.count > bestCount) { best = entry.path; bestCount = entry.count }
  }
  return best
}

function mostCommonCategory(products: Array<{ category?: ScrapedProduct['category'] }>): string | null {
  const counts = new Map<string, number>()
  for (const product of products) {
    const category = product.category?.trim()
    if (!category) continue
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  // 同数のときは先に出てきたほうを使う(Mapは挿入順)
  let best: string | null = null
  let bestCount = 0
  for (const [category, count] of counts) {
    if (count > bestCount) { best = category; bestCount = count }
  }
  return best
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > MAX_NAME_LENGTH
    ? `${normalized.slice(0, MAX_NAME_LENGTH - 1)}…`
    : normalized
}
