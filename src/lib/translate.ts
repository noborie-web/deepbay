import OpenAI from 'openai'
import { mapWithConcurrency } from '@/lib/async-pool'

// ユーザーへの説明: 「最高品質翻訳」は以前 gpt-5-nano(4.1-mini より小さい
// モデル)に対応しており名前と実態が合っていなかったため、gpt-5-mini に変更。
export const MODEL_MAP: Record<string, string> = {
  normal: 'gpt-4.1-nano',
  high:   'gpt-4.1-mini',
  best:   'gpt-5-mini',
}

let client: OpenAI | null = null
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

// gpt-5系は temperature 指定と max_tokens を受け付けない(max_completion_tokens
// を使う)。モデルごとに適切なパラメータを組み立てる。
function completionParams(model: string, maxTokens: number, temperature: number) {
  return model.startsWith('gpt-5')
    ? { model, max_completion_tokens: maxTokens }
    : { model, max_tokens: maxTokens, temperature }
}

// 本番で確認した不具合(2026-10-03): メルカリの抽出が90%(ページ取得完了)の
// あと、AI処理の途中で実行時間の上限(300秒)に達して強制終了され、商品が
// 0件になった。AI呼び出しには上限時間が無く(OpenAI SDKの既定は10分)、
// 1件のハングが抽出全体を巻き添えにしていた。1件あたりの上限を決め、
// 遅い1件は諦めて元の文章のまま進める。
const CALL_TIMEOUT_MS = Number(process.env.OPENAI_CALL_TIMEOUT_MS ?? 20_000)
const CALL_MAX_RETRIES = Number(process.env.OPENAI_CALL_MAX_RETRIES ?? 1)

function requestOptions() {
  return { timeout: CALL_TIMEOUT_MS, maxRetries: CALL_MAX_RETRIES }
}

// 並列度。タイトル・ブランドは短い応答なので高めに、説明文(入力4000字/
// 出力700トークン)は中程度にする。
export const TITLE_CONCURRENCY = Number(process.env.OPENAI_TITLE_CONCURRENCY ?? 24)
export const BRAND_CONCURRENCY = Number(process.env.OPENAI_BRAND_CONCURRENCY ?? 24)
export const DESCRIPTION_CONCURRENCY = Number(process.env.OPENAI_DESCRIPTION_CONCURRENCY ?? 20)

export interface AiBatchOptions {
  concurrency?: number
  // 残り時間が無くなったらAI処理を打ち切る。trueを返した時点以降の要素は
  // API呼び出しをせず、元の文章のまま(ブランドは未設定)で返す。
  // 「失敗」ではないので商品は除外しない。
  giveUp?: () => boolean
}

export async function translateTitle(title: string, engine: string): Promise<string> {
  const model = MODEL_MAP[engine] ?? MODEL_MAP.high
  const openai = getClient()
  const response = await openai.chat.completions.create({
    ...completionParams(model, 100, 0.1),
    messages: [
      {
        role: 'system',
        content: 'You are an expert eBay listing title translator. Translate the Japanese product title to English. Output only the translated title, nothing else. Keep brand names, model numbers, and product codes as-is. Max 80 characters. Remove Japanese marketplace (Mercari) phrases that are meaningless to international buyers, such as 値下げ交渉/値下げ/最終値下げ/本日限定/専用/取り置き/即購入OK/匿名配送/送料込み/コメント不要/フォロー割 — do not translate them (e.g. never output "Price Negotiable" or "Reserved").',
      },
      { role: 'user', content: title },
    ],
  }, requestOptions())
  return response.choices[0]?.message?.content?.trim() ?? title
}

// ユーザー要望: 商品説明を英訳し、メルカリ特有・国内向けの文章(ゆうパック/
// ヤマト等の国内配送、匿名配送、専用・取り置き、即購入OK、コメント/値下げ交渉、
// 個人名、プロフ参照 など)をAIで削除して、海外バイヤー向けの説明にする。
const DESCRIPTION_SYSTEM_PROMPT = `You are an expert at rewriting Japanese marketplace (Mercari) item descriptions into English eBay listing descriptions.

Translate the description into natural English for international buyers, and REMOVE anything that only applies to the Japanese domestic marketplace, including:
- Domestic shipping methods and carriers (ゆうパック, ヤマト, 佐川, クリックポスト, ネコポス, らくらくメルカリ便, ゆうゆうメルカリ便, 匿名配送, 送料込み/送料無料, 発送日数, 発送元 etc.)
- Domestic payment terms (翌月払い, 着払い, etc.)
- Mercari-specific phrases: 専用 / 取り置き / 即購入OK・NG / コメント逃げ / 値下げ交渉 / プロフ必読 / フォロー割 / まとめ買い割引 / 他サイトでも出品中 / いいね
- Any personal names or handles (e.g. "〇〇様"), phone numbers, social media accounts, or references to other buyers
- Requests aimed at Japanese buyers (e.g. "ご理解頂ける方のご購入をお待ちしております", "神経質な方はご遠慮ください")

KEEP and translate accurately:
- What the item is (title/edition/format, e.g. first press, limited edition, promo, sample, with obi)
- Condition details, defects, scratches, missing parts, whether it has been opened/played
- Included items (obi, booklet, bonus items, stickers) and what is NOT included
- Authenticity notes and storage notes that matter to a buyer

Rules:
- For Japanese song/album titles or artist names that have no established English name, write the romanized reading followed by the original Japanese in parentheses, e.g. "Gekka no Yasoukyoku (月下の夜想曲)".
- Output plain text only (no markdown, no HTML), in short paragraphs or bullet-like lines.
- Do not add information that is not in the original. Do not mention Mercari or Japan-only services.
- If nothing meaningful remains, output a single short sentence describing the item's condition.`

export async function translateDescription(description: string, engine: string): Promise<string> {
  const text = description.trim()
  if (!text) return ''
  const model = MODEL_MAP[engine] ?? MODEL_MAP.high
  const openai = getClient()
  const response = await openai.chat.completions.create({
    ...completionParams(model, 700, 0.2),
    messages: [
      { role: 'system', content: DESCRIPTION_SYSTEM_PROMPT },
      { role: 'user', content: text.slice(0, 4000) },
    ],
  }, requestOptions())
  return response.choices[0]?.message?.content?.trim() || text
}

export interface DescriptionTranslationResult {
  description: string
  failed: boolean
}

// 説明文の翻訳失敗は商品を除外せず、元の説明文のまま(failed:true)にする。
export async function translateDescriptionsWithFailures(
  descriptions: string[],
  engine: string,
  options: AiBatchOptions = {},
): Promise<DescriptionTranslationResult[]> {
  if (descriptions.length === 0) return []
  return mapWithConcurrency(
    descriptions,
    options.concurrency ?? DESCRIPTION_CONCURRENCY,
    async (d): Promise<DescriptionTranslationResult> => {
      if (options.giveUp?.()) return { description: d, failed: false }
      try {
        return { description: await translateDescription(d, engine), failed: false }
      } catch (e) {
        console.error('Description translation failed for one item:', e)
        return { description: d, failed: true }
      }
    },
  )
}

// ユーザー要望: ブランド設定(eBayの Brand 項目)。タイトル・説明からメーカー/
// レーベル/ブランド名を英語で抽出する。明確でなければ空(→ NO BRAND)。
export async function extractBrand(title: string, description: string, engine: string): Promise<string | null> {
  const model = MODEL_MAP[engine] ?? MODEL_MAP.high
  const openai = getClient()
  const response = await openai.chat.completions.create({
    ...completionParams(model, 30, 0),
    messages: [
      {
        role: 'system',
        content: 'Extract the manufacturer, record label, or brand name of the product for the eBay "Brand" field, written in English (Latin letters). For music CDs/DVDs, use the record label or the artist name only if it is clearly stated; otherwise answer NONE. Output only the brand name or NONE.',
      },
      { role: 'user', content: `Title: ${title}
Description: ${description.slice(0, 1500)}` },
    ],
  }, requestOptions())
  const brand = response.choices[0]?.message?.content?.trim() ?? ''
  if (!brand || /^none$/i.test(brand) || brand.length > 65) return null
  return brand
}

export async function extractBrandsSafely(
  items: Array<{ title: string; description: string }>,
  engine: string,
  options: AiBatchOptions = {},
): Promise<Array<string | null>> {
  if (items.length === 0) return []
  return mapWithConcurrency(items, options.concurrency ?? BRAND_CONCURRENCY, async (item) => {
    if (options.giveUp?.()) return null
    try {
      return await extractBrand(item.title, item.description, engine)
    } catch (e) {
      console.error('Brand extraction failed for one item:', e)
      return null
    }
  })
}

export async function translateTitles(
  titles: string[],
  engine: string,
): Promise<string[]> {
  if (titles.length === 0) return []
  return mapWithConcurrency(titles, TITLE_CONCURRENCY, (t) => translateTitle(t, engine))
}

export interface TitleTranslationResult {
  title: string
  failed: boolean
}

// ユーザー要望: 公式ツールの「タイトル翻訳失敗除外」と同等の、商品単位の
// 翻訳失敗追跡。translateTitlesは1件でもAPI呼び出しが失敗するとchunk全体の
// Promise.allが reject し、抽出パイプライン側でその結果全体を元タイトルに
// フォールバックしていた(=一部の失敗が全件のフォールバックを引き起こす)。
// この関数は商品ごとに個別にtry/catchし、失敗した商品だけをfailed:trueとして
// 返す。呼び出し側は failed な商品だけを除外できる。
export async function translateTitlesWithFailures(
  titles: string[],
  engine: string,
  options: AiBatchOptions = {},
): Promise<TitleTranslationResult[]> {
  if (titles.length === 0) return []
  return mapWithConcurrency(
    titles,
    options.concurrency ?? TITLE_CONCURRENCY,
    async (t): Promise<TitleTranslationResult> => {
      // 時間切れで翻訳を諦めた商品は failed にしない(=除外しない)。
      // 元の日本語タイトルのまま下書きとして残し、ユーザーが判断できる
      // ようにする。
      if (options.giveUp?.()) return { title: t, failed: false }
      try {
        const title = await translateTitle(t, engine)
        return { title, failed: false }
      } catch (e) {
        console.error('Title translation failed for one item:', e)
        return { title: t, failed: true }
      }
    },
  )
}

// ---------------------------------------------------------------------------
// ユーザー要望: 説明文をAIで生成する。
//  - 'missing': 仕入先から説明文が取れなかった商品(Yahoo!フリマは商品ページの
//    取得制限が厳しく、説明文だけ時間がかかる)だけ、タイトル・状態・カテゴリ等
//    から生成する
//  - 'all': 全商品について、元の説明文(あれば)も材料にして eBay向けの説明文を
//    生成する
// 推測で書かせない(付属品・欠品・傷の詳細は元情報に無ければ書かない)。
// ---------------------------------------------------------------------------

export type AiDescriptionMode = 'off' | 'missing' | 'all'

export interface DescriptionSourceInfo {
  title: string
  condition?: string | null
  category?: string | null
  brand?: string | null
  hashtags?: string[] | null
  originalDescription?: string | null
}

const GENERATE_DESCRIPTION_SYSTEM_PROMPT = `You write English eBay listing descriptions for items sold from Japan.

You are given structured facts about one item (Japanese title, condition grade, category, brand, tags, and possibly the seller's original Japanese description). Write a concise, natural description for international buyers.

Rules:
- Use ONLY the facts given. Never invent included items, defects, editions, working status, or measurements. If the original description is not provided, do not guess details; you may say "Please see photos for details."
- Translate the item name; keep brand names, model numbers, and product codes as-is. For Japanese titles/artists with no established English name, write the romanized reading followed by the original Japanese in parentheses.
- State the condition grade in buyer-friendly words (e.g. "Used - no noticeable scratches or stains").
- Mention that it is the Japanese version / ships from Japan when relevant (games, media, books: note region/language, e.g. NTSC-J, Japanese text).
- If an original description is provided, translate its buyer-relevant facts (condition details, included/missing items, edition) and REMOVE Japanese-marketplace-only content (domestic shipping carriers, 匿名配送, 専用/取り置き, 即購入OK, 値下げ交渉, personal names, comments to Japanese buyers).
- Do not mention Mercari, Yahoo, PayPay, or Japan-only services. No prices.
- Output plain text only (no markdown, no HTML), 3-8 short lines.`

function describeSource(info: DescriptionSourceInfo): string {
  const lines = [`Title (Japanese): ${info.title}`]
  if (info.condition) lines.push(`Condition grade: ${info.condition}`)
  if (info.category) lines.push(`Category: ${info.category}`)
  if (info.brand) lines.push(`Brand/Maker: ${info.brand}`)
  if (info.hashtags && info.hashtags.length > 0) lines.push(`Tags: ${info.hashtags.slice(0, 10).join(', ')}`)
  const original = info.originalDescription?.trim()
  lines.push(original ? `Original description (Japanese):\n${original.slice(0, 3000)}` : 'Original description: (not available)')
  return lines.join('\n')
}

export async function generateDescription(info: DescriptionSourceInfo, engine: string): Promise<string> {
  const model = MODEL_MAP[engine] ?? MODEL_MAP.high
  const openai = getClient()
  const response = await openai.chat.completions.create({
    ...completionParams(model, 500, 0.3),
    messages: [
      { role: 'system', content: GENERATE_DESCRIPTION_SYSTEM_PROMPT },
      { role: 'user', content: describeSource(info) },
    ],
  }, requestOptions())
  return response.choices[0]?.message?.content?.trim() ?? ''
}

export interface GeneratedDescriptionResult { description: string | null; failed: boolean }

// 生成に失敗した商品は null(呼び出し側で元の説明文/翻訳を使う)
export async function generateDescriptionsSafely(
  items: DescriptionSourceInfo[],
  engine: string,
  options: AiBatchOptions = {},
): Promise<GeneratedDescriptionResult[]> {
  if (items.length === 0) return []
  return mapWithConcurrency(
    items,
    options.concurrency ?? DESCRIPTION_CONCURRENCY,
    async (item): Promise<GeneratedDescriptionResult> => {
      if (options.giveUp?.()) return { description: null, failed: true }
      try {
        const description = await generateDescription(item, engine)
        return description ? { description, failed: false } : { description: null, failed: true }
      } catch (e) {
        console.error('Description generation failed for one item:', e)
        return { description: null, failed: true }
      }
    },
  )
}

export function normalizeAiDescriptionMode(value: unknown): AiDescriptionMode {
  return value === 'all' || value === 'off' ? value : 'missing'
}
