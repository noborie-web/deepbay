import OpenAI from 'openai'

const MODEL_MAP: Record<string, string> = {
  normal: 'gpt-4.1-nano',
  high:   'gpt-4.1-mini',
  best:   'gpt-5-nano',
}

let client: OpenAI | null = null
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

export async function translateTitle(title: string, engine: string): Promise<string> {
  const model = MODEL_MAP[engine] ?? MODEL_MAP.high
  const openai = getClient()
  const response = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are an expert eBay listing title translator. Translate the Japanese product title to English. Output only the translated title, nothing else. Keep brand names, model numbers, and product codes as-is. Max 80 characters.',
      },
      { role: 'user', content: title },
    ],
    max_tokens: 100,
    temperature: 0.1,
  })
  return response.choices[0]?.message?.content?.trim() ?? title
}

type TranslationProgress = (completed: number, total: number) => void | Promise<void>
type BatchTranslator = (titles: string[]) => Promise<string[]>

const TITLE_BATCH_SIZE = 40
const TITLE_BATCH_CONCURRENCY = 3

async function translateTitleBatch(titles: string[], engine: string): Promise<string[]> {
  const model = MODEL_MAP[engine] ?? MODEL_MAP.high
  const response = await getClient().chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: [
          'Translate every Japanese product title in the input JSON array to an English eBay listing title.',
          'Keep the same order and the same number of items.',
          'Keep brand names, model numbers, and product codes as-is.',
          'Each translated title must be at most 80 characters.',
          'Return only JSON in this exact shape: {"translations":["title 1","title 2"]}.',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify(titles) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: Math.min(12_000, Math.max(1_000, titles.length * 120)),
    temperature: 0.1,
  })

  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('Translation response was empty')

  const parsed = JSON.parse(content) as { translations?: unknown }
  if (
    !Array.isArray(parsed.translations)
    || parsed.translations.length !== titles.length
    || parsed.translations.some((title) => typeof title !== 'string')
  ) {
    throw new Error('Translation response count did not match the request')
  }

  return parsed.translations.map((title) => title.trim().slice(0, 80))
}

export async function _translateTitlesInBatches(
  titles: string[],
  translateBatch: BatchTranslator,
  onProgress?: TranslationProgress,
  batchSize = TITLE_BATCH_SIZE,
  concurrency = TITLE_BATCH_CONCURRENCY,
): Promise<string[]> {
  if (titles.length === 0) return []

  const batches: string[][] = []
  for (let index = 0; index < titles.length; index += batchSize) {
    batches.push(titles.slice(index, index + batchSize))
  }

  const results: string[] = []
  let completed = 0

  for (let index = 0; index < batches.length; index += concurrency) {
    const wave = batches.slice(index, index + concurrency)
    const translatedWave = await Promise.all(wave.map(async (batch) => {
      try {
        const translated = await translateBatch(batch)
        return translated.length === batch.length ? translated : batch
      } catch (error) {
        console.error('Title translation batch failed, using original titles:', error)
        return batch
      }
    }))

    for (const translated of translatedWave) {
      results.push(...translated)
      completed += translated.length
    }
    await onProgress?.(completed, titles.length)
  }

  return results
}

export async function translateTitles(
  titles: string[],
  engine: string,
  onProgress?: TranslationProgress,
): Promise<string[]> {
  return _translateTitlesInBatches(
    titles,
    (batch) => translateTitleBatch(batch, engine),
    onProgress,
  )
}
