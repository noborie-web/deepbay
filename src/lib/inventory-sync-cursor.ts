import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_NEXT_PAGE = 100_000

interface InventorySyncCursorPayload {
  version: 1
  runId: string
  nextPage: number
  // ユーザー要望(2026-09-25): 出品アカウントを複数運用する。手動同期は
  // セラーを順番に処理するため、次に処理するセラーの位置も引き継ぐ。
  sellerIndex?: number
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

export function createInventorySyncCursor(
  runId: string,
  nextPage: number,
  secret: string,
  sellerIndex = 0,
): string {
  // nextPageは「次に処理するバッチ番号」。個別照会方式ではバッチ数が
  // Kakehashiの出品数に比例するため、旧方式のページ上限(25)は撤廃する。
  // 次のセラーに移るときは、そのセラーの1バッチ目から始める。
  if (!runId || !Number.isInteger(nextPage) || nextPage < 1 || nextPage > MAX_NEXT_PAGE) {
    throw new Error('Invalid inventory sync cursor values')
  }
  if (!Number.isInteger(sellerIndex) || sellerIndex < 0 || sellerIndex > 100) {
    throw new Error('Invalid inventory sync cursor values')
  }
  if (nextPage === 1 && sellerIndex === 0) {
    throw new Error('Invalid inventory sync cursor values')
  }
  if (!secret) throw new Error('Inventory sync cursor secret is not configured')

  const payload = Buffer.from(JSON.stringify({
    version: 1,
    runId,
    nextPage,
    sellerIndex,
  } satisfies InventorySyncCursorPayload)).toString('base64url')
  const signature = sign(payload, secret).toString('base64url')
  return `${payload}.${signature}`
}

export function parseInventorySyncCursor(
  cursor: string,
  secret: string,
): InventorySyncCursorPayload {
  if (!secret) throw new Error('Inventory sync cursor secret is not configured')

  const [payload, signature, extra] = cursor.split('.')
  if (!payload || !signature || extra) throw new Error('Invalid inventory sync cursor')

  const actualSignature = Buffer.from(signature, 'base64url')
  const expectedSignature = sign(payload, secret)
  if (
    actualSignature.length !== expectedSignature.length
    || !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error('Invalid inventory sync cursor')
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<InventorySyncCursorPayload>
    if (
      parsed.version !== 1
      || typeof parsed.runId !== 'string'
      || !parsed.runId
      || !Number.isInteger(parsed.nextPage)
      || parsed.nextPage! < 1
      || parsed.nextPage! > MAX_NEXT_PAGE
      || (parsed.sellerIndex !== undefined
        && (!Number.isInteger(parsed.sellerIndex) || parsed.sellerIndex < 0 || parsed.sellerIndex > 100))
      || (parsed.nextPage === 1 && (parsed.sellerIndex ?? 0) === 0)
    ) {
      throw new Error('Invalid inventory sync cursor')
    }
    return parsed as InventorySyncCursorPayload
  } catch {
    throw new Error('Invalid inventory sync cursor')
  }
}
