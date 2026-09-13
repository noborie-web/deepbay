// eBayのTaxonomy API(get_item_aspects_for_category)を使って、出品先
// カテゴリごとに実際にeBayが認識するItem Specifics項目名を取得する。
// CSV出力(listing-export.ts)が、全カテゴリ共通の固定リスト(ゲーム向け)
// ではなく、実際のカテゴリに応じた正しい項目セットを出力できるように
// するためのもの。

export interface EbayAspect {
  name: string
  required: boolean
}

const DEFAULT_CATEGORY_TREE_ID = '0' // EBAY_US

async function getEbayAppAccessToken(): Promise<string> {
  const clientId = (process.env.EBAY_CLIENT_ID ?? '').trim()
  const clientSecret = (process.env.EBAY_CLIENT_SECRET ?? '').trim()
  if (!clientId || !clientSecret) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET が設定されていません')
  }
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`eBay auth failed: ${res.status} ${text}`)
  }
  const data = await res.json()
  return data.access_token
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAspects(json: any): EbayAspect[] {
  const aspects: unknown[] = Array.isArray(json?.aspects) ? json.aspects : []
  const seen = new Set<string>()
  const result: EbayAspect[] = []
  for (const a of aspects) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aspect = a as any
    const name = typeof aspect?.localizedAspectName === 'string' ? aspect.localizedAspectName.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push({ name, required: aspect?.aspectConstraint?.aspectRequired === true })
  }
  // 必須項目を先に並べる(CSV列としての見やすさのため)
  return result.sort((a, b) => Number(b.required) - Number(a.required))
}

// eBay Taxonomy APIからカテゴリの実際のItem Specifics項目一覧を取得する。
// ネットワークエラー・認証情報未設定・不正なカテゴリIDなどの場合はエラーを
// 投げる(呼び出し側でフォールバックを判断する)。
export async function fetchCategoryAspects(
  categoryId: string,
  categoryTreeId: string = DEFAULT_CATEGORY_TREE_ID,
): Promise<EbayAspect[]> {
  const token = await getEbayAppAccessToken()
  const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Taxonomy API failed: ${res.status} ${text}`)
  }
  const json = await res.json()
  return parseAspects(json)
}

const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30日

// キャッシュ(ebay_category_aspectsテーブル)を優先し、無い/古い場合のみ
// eBay Taxonomy APIへ実際に問い合わせる。取得に失敗した場合はnullを返し、
// 呼び出し側(CSV生成)は既定の固定リストにフォールバックする。
// Supabaseクライアントの型はテーブルごとの複雑なジェネリクスを持つため、
// 呼び出し側の型検査を煩雑にしないようにあえてanyで受け取る。
export async function getCategoryItemSpecificsNames(
  categoryId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  categoryTreeId: string = DEFAULT_CATEGORY_TREE_ID,
): Promise<string[] | null> {
  try {
    const { data: cached } = await client
      .from('ebay_category_aspects')
      .select('aspect_names, fetched_at')
      .eq('category_id', categoryId)
      .maybeSingle()

    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_MAX_AGE_MS) {
      const names = cached.aspect_names
      if (Array.isArray(names) && names.length > 0) return names as string[]
    }

    const aspects = await fetchCategoryAspects(categoryId, categoryTreeId)
    if (aspects.length === 0) return null
    const names = aspects.map((a) => a.name)

    await client.from('ebay_category_aspects').upsert({
      category_id: categoryId,
      category_tree_id: categoryTreeId,
      aspect_names: names,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'category_id' })

    return names
  } catch (error) {
    console.warn('eBay category aspects fetch failed, falling back to default columns:', error)
    return null
  }
}
