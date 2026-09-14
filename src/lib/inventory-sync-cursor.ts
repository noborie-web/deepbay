import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_NEXT_PAGE = 100_000

interface InventorySyncCursorPayload {
  version: 1
  runId: string
  nextPage: number
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

export function createInventorySyncCursor(
  runId: string,
  nextPage: number,
  secret: string,
): string {
  // nextPageは「次に処理するバッチ番号」。個別照会方式ではバッチ数が
  // Kakehashiの出品数に比例するため、旧方式のページ上限(25)は撤廃する。
  if (!runId || !Number.isInteger(nextPage) || nextPage < 2 || nextPage > MAX_NEXT_PAGE) {
    throw new Error('Invalid inventory sync cursor values')
  }
  if (!secret) throw new Error('Inventory sync cursor secret is not configured')

  const payload = Buffer.from(JSON.stringify({
    version: 1,
    runId,
    nextPage,
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
      || parsed.nextPage! < 2
      || parsed.nextPage! > MAX_NEXT_PAGE
    ) {
      throw new Error('Invalid inventory sync cursor')
    }
    return parsed as InventorySyncCursorPayload
  } catch {
    throw new Error('Invalid inventory sync cursor')
  }
}
