import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { PRODUCT_WRITE_WHITELIST, validateProductFields } from '@/lib/pricing'

function pickAllowed(updates: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).filter(([k]) => PRODUCT_WRITE_WHITELIST.has(k))
  )
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ extractionId: string }> }) {
  const { extractionId } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Parse JSON
  let body: { updates?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '不正なJSONです' }, { status: 400 })
  }

  const rawUpdates = body.updates
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    return NextResponse.json({ error: '更新データがありません' }, { status: 400 })
  }
  if (rawUpdates.length > 200) {
    return NextResponse.json({ error: '一度に更新できるのは200件までです' }, { status: 400 })
  }

  // 各アイテムの型チェック（null・プリミティブ・配列は拒否）
  for (const item of rawUpdates) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return NextResponse.json({ error: '各アイテムはオブジェクトである必要があります' }, { status: 400 })
    }
  }

  // 重複 productId チェック
  const seenIds = new Set<string>()
  for (const item of rawUpdates) {
    const id = (item as { productId?: unknown }).productId
    if (typeof id !== 'string' || id.trim() === '') {
      return NextResponse.json({ error: 'productId が無効です' }, { status: 400 })
    }
    if (seenIds.has(id)) {
      return NextResponse.json({ error: `productId "${id}" が重複しています` }, { status: 400 })
    }
    seenIds.add(id)
  }

  const admin = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const succeeded: string[] = []
  const failed: { productId: string; error: string }[] = []
  const now = new Date().toISOString()

  const CHUNK_SIZE = 10
  for (let i = 0; i < rawUpdates.length; i += CHUNK_SIZE) {
    await Promise.all(
      rawUpdates.slice(i, i + CHUNK_SIZE).map(async (item) => {
        const { productId, ...rawFields } = item as { productId: string; [key: string]: unknown }
        const fields = pickAllowed(rawFields)

        if (Object.keys(fields).length === 0) {
          failed.push({ productId, error: '更新可能なフィールドがありません' })
          return
        }

        // サーバー側フィールド検証
        const validationError = validateProductFields(fields)
        if (validationError) {
          failed.push({ productId, error: validationError })
          return
        }

        const { data, error } = await admin
          .from('products')
          .update({ ...fields, updated_at: now })
          .eq('id', productId)
          .eq('extraction_id', extractionId)
          .eq('user_id', user.id)
          .select('id')

        if (error) {
          failed.push({ productId, error: error.message })
        } else if (!data || data.length === 0) {
          failed.push({ productId, error: '商品が存在しないか、更新権限がありません' })
        } else {
          succeeded.push(productId)
        }
      })
    )
  }

  if (failed.length > 0) {
    return NextResponse.json({ ok: false, succeeded, failed }, { status: 422 })
  }

  return NextResponse.json({ ok: true, succeeded, failed: [] }, { status: 200 })
}

