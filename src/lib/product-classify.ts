import OpenAI from 'openai'
import { completionParams, MODEL_MAP } from '@/lib/translate'

// ユーザー要望(2026-10-18): リールのカテゴリで抽出しても、スプールやハンドル
// などの部品が混ざる。キーワードでは拾いきれない(「Light Arm」「ドラググリス」
// のように部品名が商品名化していて語彙に限りがない)ため、AIに判定させる。
//
// タイトルと1枚目の画像を一度に見せる。互いの弱点を補い合う:
//   - 「管516iP」のような型番だけのタイトル → 画像が補う
//   - 箱しか写っていない写真              → タイトルが補う
// 画像は detail: 'low' の1枚だけにして、費用と時間を抑える。

// ユーザー要望(2026-10-23): 「部品かどうか」だけでなく、その場で書いた指示
// (「ジャンク品を除外」「ポケモン以外を除外」など)でもAIに判定させたい。
// 判定の呼び出し方は同じなので、プロンプトだけ差し替える。
//
// 判定しても何も消さないのは部品判定と同じ。印を付けるだけにして、理由を
// 見てから自分で消してもらう(AIの誤判定で商品が勝手に消えないようにする)。

/** 判定の種類。part=本体か部品か / custom=その場で書いた指示 */
export type ClassifyMode = 'part' | 'custom'

/** 1件あたりの判定結果 */
export interface ClassifyVerdict {
  /** part モード: main|part / custom モード: keep|exclude / 共通: unknown */
  verdict: 'main' | 'part' | 'keep' | 'exclude' | 'unknown'
  /** なぜそう判断したか(日本語・短く)。画面で確認するために残す */
  reason: string
}

export interface ClassifyInput {
  id: string
  title: string
  /** 仕入先の元タイトル(日本語)。英訳で落ちた情報を補う */
  originalTitle: string
  imageUrl: string | null
}

export const CLASSIFY_CONCURRENCY = Number(process.env.OPENAI_CLASSIFY_CONCURRENCY ?? 20)

// ユーザー要望(2026-10-18): 判定は精度を高めに。既定を best(gpt-5-mini)にする。
export const CLASSIFY_MODEL = MODEL_MAP.best

// 出力は短いJSONだが、gpt-5系は推論トークンもこの上限を食う。
// 小さすぎると推論だけで使い切って本文が空になり unknown になる。
// 本番で確認(2026-10-19): 400トークンでも309件中8件が「応答が空」だった。
// 出力自体は短いので、上限を上げても実際の消費はほとんど増えない。
const MAX_OUTPUT_TOKENS = 1200

export function systemPrompt(expected: string | null, instruction?: string | null): string {
  const target = expected?.trim()
  const order = instruction?.trim()
  // その場で書いた指示があれば、そちらを基準にする
  if (order) {
    return [
      'あなたは中古品の出品者です。出品一覧から、指示に合う商品を選び出します。',
      target ? `この一覧は「${target}」を集めたものです。` : '',
      '',
      `出品者の指示: ${order}`,
      '',
      '判定の基準:',
      '- exclude: 指示に当てはまる(= 一覧から外したい)商品',
      '- keep: 指示に当てはまらない商品',
      '- unknown: タイトルと画像のどちらからも判断できない',
      '',
      '迷ったら unknown にする。確信が持てないものを exclude にしない',
      '(exclude にした商品は出品者が削除するため)。',
      '',
      '出力は次のJSONだけ。説明文は書かない:',
      '{"verdict":"exclude|keep|unknown","reason":"日本語で20文字以内の理由"}',
    ].filter(Boolean).join('\n')
  }
  return [
    'あなたは中古品の出品者です。商品が「本体(完成品そのもの)」か',
    '「部品・付属品・消耗品」かを判定します。',
    target ? `この一覧は「${target}」を集めたものです。` : '',
    '',
    '判定の基準:',
    '- main: その商品カテゴリの本体。壊れていても、付属品が欠けていても本体なら main',
    '  (例: リールの「本体のみ」「ハンドル無し」「ジャンク」は main)',
    '- part: 本体ではない部品・交換パーツ・付属品・消耗品・工具・収納品',
    '  (例: スプール単体、ハンドル単体、ノブ、ベアリング、グリス、ケース、ステッカー)',
    '- unknown: タイトルと画像のどちらからも判断できない',
    '',
    '出力は次のJSONだけ。説明文は書かない:',
    '{"verdict":"main|part|unknown","reason":"日本語で20文字以内の理由"}',
  ].filter(Boolean).join('\n')
}

/** モデルの応答を読む。壊れていたら unknown にして、商品は消さない */
export function parseVerdict(content: string | null | undefined, mode: ClassifyMode = 'part'): ClassifyVerdict {
  if (!content) return { verdict: 'unknown', reason: '応答が空' }
  // ```json ... ``` で包まれて返ることがある
  const json = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  // モード外の値を受け入れると、指示と関係ない判定が混ざる
  const allowed = mode === 'custom' ? ['keep', 'exclude'] : ['main', 'part']
  try {
    const parsed = JSON.parse(json) as { verdict?: unknown; reason?: unknown }
    const verdict = typeof parsed.verdict === 'string' && allowed.includes(parsed.verdict)
      ? parsed.verdict as ClassifyVerdict['verdict']
      : 'unknown'
    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 60) : ''
    return { verdict, reason }
  } catch {
    return { verdict: 'unknown', reason: '応答を読めなかった' }
  }
}

export async function classifyProduct(
  openai: OpenAI,
  input: ClassifyInput,
  options: {
    model?: string
    expectedCategory?: string | null
    timeoutMs?: number
    /** その場で書いた指示。あれば「指示に当てはまるか」を判定する */
    instruction?: string | null
  } = {},
): Promise<ClassifyVerdict & { model: string }> {
  const model = options.model ?? CLASSIFY_MODEL
  const mode: ClassifyMode = options.instruction?.trim() ? 'custom' : 'part'
  const text = [
    `英語タイトル: ${input.title}`,
    `元のタイトル(日本語): ${input.originalTitle}`,
  ].join('\n')

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text }]
  if (input.imageUrl) {
    // detail: 'low' で固定。枚数は1枚だけにして費用と時間を抑える
    content.push({ type: 'image_url', image_url: { url: input.imageUrl, detail: 'low' } })
  }

  try {
    const response = await openai.chat.completions.create({
      // gpt-5系は temperature と max_tokens を受け付けない。
      // 直接指定するとモデルを上げた瞬間に全件失敗するため、必ずこれを通す
      ...completionParams(model, MAX_OUTPUT_TOKENS, 0),
      messages: [
        { role: 'system', content: systemPrompt(options.expectedCategory ?? null, options.instruction ?? null) },
        { role: 'user', content },
      ],
    }, { timeout: options.timeoutMs ?? 20_000, maxRetries: 1 })
    return { ...parseVerdict(response.choices[0]?.message?.content, mode), model }
  } catch (error) {
    // 判定できなくても商品は消さない。unknown にして次回また試せるようにする
    const message = error instanceof Error ? error.message : '不明なエラー'
    return { verdict: 'unknown', reason: `判定に失敗: ${message.slice(0, 40)}`, model }
  }
}
