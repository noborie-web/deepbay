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
