// ユーザー要望(2026-10-18): 商品編集で不要な商品を目視で選んで削除したい。
// 数百件を端から見るのは現実的でないので、「怪しいもの」だけに絞れるようにする。
//
// eBayのタイトル上限は80文字。画面でも「42 / 80」と出している。
const TITLE_LIMIT = 80
// 残り5文字を切ったら、翻訳や接頭辞の追加で切れる恐れがあるものとして拾う
const TITLE_NEAR_LIMIT = TITLE_LIMIT - 5

export type ReviewFlag =
  | 'few_images'      // 画像が1枚以下(出品の見栄えが悪い)
  | 'no_description'  // 説明文が空
  | 'no_price'        // eBay販売価格が未設定
  | 'long_title'      // タイトルが上限ぎりぎり
  | 'no_brand'        // ブランド未設定
  | 'duplicate_title' // 同じタイトルが複数ある(重複出品の候補)

export const REVIEW_FLAG_LABELS: Record<ReviewFlag, string> = {
  few_images: '画像1枚以下',
  no_description: '説明文なし',
  no_price: '価格未設定',
  long_title: 'タイトル長い',
  no_brand: 'ブランドなし',
  duplicate_title: 'タイトル重複',
}

export interface ReviewItem {
  id: string
  title: string
  brand: string
  description: string
  price: number | null
  images: string[]
}

/**
 * 重複判定用にタイトルをそろえる。
 * 大文字小文字・連続空白・記号の違いだけの差は同じものとして扱う。
 */
export function normalizeTitleForDuplicate(title: string): string {
  return title
    .toLowerCase()
    // 記号は消さずに空白へ。消すと "REEL-Case" が "reelcase" になり、
    // "reel case" と別物になってしまう
    .replace(/[!-/:-@[-`{-~]/g, ' ')
    .replace(/[\s　]+/g, ' ')
    .trim()
}

/** 同じタイトルが2件以上ある商品のIDを返す */
export function findDuplicateTitleIds(items: ReviewItem[]): Set<string> {
  const byTitle = new Map<string, string[]>()
  for (const item of items) {
    const key = normalizeTitleForDuplicate(item.title)
    if (!key) continue
    const ids = byTitle.get(key) ?? []
    ids.push(item.id)
    byTitle.set(key, ids)
  }
  const duplicates = new Set<string>()
  for (const ids of byTitle.values()) {
    if (ids.length > 1) for (const id of ids) duplicates.add(id)
  }
  return duplicates
}

export function productReviewFlags(item: ReviewItem, duplicateIds: Set<string>): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  if (item.images.length <= 1) flags.push('few_images')
  if (!item.description.trim()) flags.push('no_description')
  if (item.price === null) flags.push('no_price')
  if (item.title.length >= TITLE_NEAR_LIMIT) flags.push('long_title')
  if (!item.brand.trim()) flags.push('no_brand')
  if (duplicateIds.has(item.id)) flags.push('duplicate_title')
  return flags
}

/**
 * 絞り込みで残す商品を決める。選んだ条件の**どれかに当てはまる**ものを残す
 * (「怪しいものを集める」ための絞り込みなので、AND ではなく OR)。
 * 何も選んでいなければ全件を残す。
 */
export function matchesReviewFilter(flags: ReviewFlag[], selected: Set<ReviewFlag>): boolean {
  if (selected.size === 0) return true
  return flags.some((flag) => selected.has(flag))
}

/**
 * 重複したタイトルを隣り合わせに並べる。
 * 見比べてどちらを消すか決めやすくするため、重複以外は元の順のまま後ろに置く。
 */
export function sortDuplicatesTogether(items: ReviewItem[], duplicateIds: Set<string>): ReviewItem[] {
  const duplicates = items.filter((item) => duplicateIds.has(item.id))
  const rest = items.filter((item) => !duplicateIds.has(item.id))
  duplicates.sort((a, b) => {
    const left = normalizeTitleForDuplicate(a.title)
    const right = normalizeTitleForDuplicate(b.title)
    return left === right ? 0 : left < right ? -1 : 1
  })
  return [...duplicates, ...rest]
}
