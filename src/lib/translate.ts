import OpenAI from 'openai'

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

export async function translateTitle(title: string, engine: string): Promise<string> {
  const model = MODEL_MAP[engine] ?? MODEL_MAP.high
  const openai = getClient()
  const response = await openai.chat.completions.create({
    ...completionParams(model, 100, 0.1),
    messages: [
      {
        role: 'system',
        content: 'You are an expert eBay listing title translator. Translate the Japanese product title to English. Output only the translated title, nothing else. Keep brand names, model numbers, and product codes as-is. Max 80 characters.',
      },
      { role: 'user', content: title },
    ],
  })
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
  })
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
): Promise<DescriptionTranslationResult[]> {
  if (descriptions.length === 0) return []
  const results: DescriptionTranslationResult[] = []
  const chunkSize = 5
  for (let i = 0; i < descriptions.length; i += chunkSize) {
    const chunk = descriptions.slice(i, i + chunkSize)
    const translated = await Promise.all(chunk.map(async (d): Promise<DescriptionTranslationResult> => {
      try {
        return { description: await translateDescription(d, engine), failed: false }
      } catch (e) {
        console.error('Description translation failed for one item:', e)
        return { description: d, failed: true }
      }
    }))
    results.push(...translated)
  }
  return results
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
  })
  const brand = response.choices[0]?.message?.content?.trim() ?? ''
  if (!brand || /^none$/i.test(brand) || brand.length > 65) return null
  return brand
}

export async function extractBrandsSafely(
  items: Array<{ title: string; description: string }>,
  engine: string,
): Promise<Array<string | null>> {
  if (items.length === 0) return []
  const results: Array<string | null> = []
  const chunkSize = 10
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)
    const brands = await Promise.all(chunk.map(async (item) => {
      try {
        return await extractBrand(item.title, item.description, engine)
      } catch (e) {
        console.error('Brand extraction failed for one item:', e)
        return null
      }
    }))
    results.push(...brands)
  }
  return results
}

export async function translateTitles(
  titles: string[],
  engine: string,
): Promise<string[]> {
  if (titles.length === 0) return []
  // 10件ずつ並列処理
  const results: string[] = []
  const chunkSize = 10
  for (let i = 0; i < titles.length; i += chunkSize) {
    const chunk = titles.slice(i, i + chunkSize)
    const translated = await Promise.all(chunk.map((t) => translateTitle(t, engine)))
    results.push(...translated)
  }
  return results
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
): Promise<TitleTranslationResult[]> {
  if (titles.length === 0) return []
  const results: TitleTranslationResult[] = []
  const chunkSize = 10
  for (let i = 0; i < titles.length; i += chunkSize) {
    const chunk = titles.slice(i, i + chunkSize)
    const translated = await Promise.all(chunk.map(async (t): Promise<TitleTranslationResult> => {
      try {
        const title = await translateTitle(t, engine)
        return { title, failed: false }
      } catch (e) {
        console.error('Title translation failed for one item:', e)
        return { title: t, failed: true }
      }
    }))
    results.push(...translated)
  }
  return results
}
