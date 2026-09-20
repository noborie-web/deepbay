import { scrapeUrl } from '@/lib/scrapers'

// ユーザー要望(事故復旧): 仕入先URLが消えた商品について、元タイトル(抽出時の
// 日本語タイトル、先頭30文字程度)と仕入価格でメルカリを検索し、一致する
// 出品を仕入先URLとして復元する。

export interface SupplierCandidate {
  sourceUrl: string
  title: string
  price: number | null
  availability: string | null
  score: number
  // 仕入価格と一致(同名商品が複数ある場合の決め手)
  priceMatch: boolean
}

export interface SupplierMatchResult {
  best: SupplierCandidate | null
  candidates: SupplierCandidate[]
  // 自動採用してよい確度(タイトル一致 + 価格一致など)
  confident: boolean
}

export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[【】\[\]()（）「」『』《》≪≫☆★※♪⭐︎‼️!！?？・･,，.。、:：;；\-–—_/／\\|~〜…"'“”‘’]/g, '')
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

// 2文字組の Dice 係数(0〜1)
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a), nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  // 元タイトルは30文字で切れていることがあるため、前方一致は高く評価する
  if (nb.startsWith(na) || na.startsWith(nb)) return 0.97
  const ba = bigrams(na), bb = bigrams(nb)
  let inter = 0
  for (const g of ba) if (bb.has(g)) inter++
  return (2 * inter) / (ba.size + bb.size)
}

export function isPriceMatch(product: { priceJpy: number | null }, candidate: { price: number | null }): boolean {
  return product.priceJpy != null && candidate.price != null && Math.abs(candidate.price - product.priceJpy) < 1
}

export function scoreCandidate(
  product: { title: string; priceJpy: number | null },
  candidate: { title: string; price: number | null },
): number {
  const sim = titleSimilarity(product.title, candidate.title)
  // 価格一致は強い根拠(同名商品が複数ある場合の決め手)
  return Math.min(1, sim + (isPriceMatch(product, candidate) ? 0.15 : 0))
}

// 検索キーワード: 装飾記号を除き、先頭の意味のある語を使う
export function buildSearchKeyword(title: string): string {
  const cleaned = title
    .normalize('NFKC')
    .replace(/[【】\[\]「」『』《》≪≫☆★※♪⭐︎‼️!！?？]/g, ' ')
    .replace(/(激レア|超激レア|超希少|希少|稀少|レア|廃盤|入手困難|非売品|美品|新品未開封|新品|未開封|即購入ok|値下げ|最終値下げ|本日限定|匿名配送)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || title).slice(0, 40)
}

// 元タイトルは30文字で切れていることが多く、末尾の語が途中で切れている
// (例:「韓国ド」)と検索が0件になる。語を後ろから減らしながら再検索する。
export function buildSearchKeywords(title: string): string[] {
  const base = buildSearchKeyword(title)
  const tokens = base.split(' ').filter(Boolean)
  const variants: string[] = [base]
  if (tokens.length > 1) variants.push(tokens.slice(0, -1).join(' '))
  if (tokens.length > 3) variants.push(tokens.slice(0, 3).join(' '))
  if (tokens.length > 2) variants.push(tokens.slice(0, 2).join(' '))
  // 1語だけのタイトルで末尾が切れている場合は末尾1文字を落とす
  if (tokens.length === 1 && base.length >= 10) variants.push(base.slice(0, -1))
  return Array.from(new Set(variants.map(v => v.trim()).filter(v => v.length >= 2)))
}

export async function findSupplierMatch(
  product: { title: string; priceJpy: number | null },
  options: { limit?: number } = {},
): Promise<SupplierMatchResult> {
  let candidates: SupplierCandidate[] = []
  for (const keyword of buildSearchKeywords(product.title)) {
    const url = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}`
    let results: Awaited<ReturnType<typeof scrapeUrl>> = []
    try {
      results = await scrapeUrl(url, { limit: options.limit ?? 30, skipDetailEnrichment: true })
    } catch (error) {
      // 「検索結果が0件です」等は次のキーワードで再検索する
      if (!(error instanceof Error && /0件/.test(error.message))) throw error
    }
    candidates = results
      .map((r) => ({
        sourceUrl: r.sourceUrl,
        title: r.title,
        price: r.price ?? null,
        availability: (r as { availability?: string | null }).availability ?? null,
        score: scoreCandidate(product, { title: r.title, price: r.price ?? null }),
        priceMatch: isPriceMatch(product, { price: r.price ?? null }),
      }))
      // 同点(同名商品)なら価格が一致する方を優先
      .sort((a, b) => (b.score - a.score) || (Number(b.priceMatch) - Number(a.priceMatch)))
      .slice(0, 5)
    // 確度の高い候補が見つかればそこで打ち切る(見つからなければ緩い検索へ)
    if (candidates[0] && candidates[0].score >= 0.9) break
  }
  const best = candidates[0] ?? null
  const second = candidates[1]?.score ?? 0
  // タイトルがほぼ一致し、かつ「2位と差がある」または「価格も一致」なら自動採用
  const confident = !!best && best.score >= 0.9 && (best.score - second >= 0.05 || (best.priceMatch && best.score >= 0.97))
  return { best, candidates, confident }
}
