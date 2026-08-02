export interface ProductBulkUpdate {
  productId: string
  [key: string]: unknown
}

export interface ProductBulkSaveFailure {
  productId: string
  error: string
}

export interface ProductBulkSaveResult {
  succeeded: string[]
  failed: ProductBulkSaveFailure[]
}

export const PRODUCT_SAVE_BATCH_SIZE = 200

type Fetcher = typeof fetch

export async function saveProductUpdatesInBatches(
  extractionId: string,
  updates: ProductBulkUpdate[],
  fetcher: Fetcher = fetch,
): Promise<ProductBulkSaveResult> {
  const succeeded: string[] = []
  const failed: ProductBulkSaveFailure[] = []

  for (let offset = 0; offset < updates.length; offset += PRODUCT_SAVE_BATCH_SIZE) {
    const chunk = updates.slice(offset, offset + PRODUCT_SAVE_BATCH_SIZE)

    try {
      const response = await fetcher(`/api/products/${extractionId}/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: chunk }),
      })
      const json: {
        ok?: boolean
        error?: string
        succeeded?: string[]
        failed?: ProductBulkSaveFailure[]
      } = await response.json().catch(() => ({}))

      if (Array.isArray(json.succeeded)) succeeded.push(...json.succeeded)
      if (Array.isArray(json.failed)) failed.push(...json.failed)

      if (json.ok === true && !Array.isArray(json.succeeded)) {
        succeeded.push(...chunk.map((update) => update.productId))
      } else if (json.ok !== true && !Array.isArray(json.failed)) {
        const error = json.error ?? `保存APIエラー（${response.status}）`
        failed.push(...chunk.map((update) => ({ productId: update.productId, error })))
      }
    } catch (error) {
      const message = `通信エラー: ${error instanceof Error ? error.message : '不明なエラー'}`
      const remaining = updates.slice(offset)
      failed.push(...remaining.map((update) => ({ productId: update.productId, error: message })))
      break
    }
  }

  return { succeeded, failed }
}
