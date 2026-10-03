import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Extraction, Product } from '@/types/database'

// 本番で確認した不具合(2026-10-03): 抽出が90%のまま「処理中」で止まり続けた。
// 実行環境ごと落ちるとタイマーも動かないため、状況確認のたびに古い「処理中」を
// 失敗として確定させる(抽出の実行時間の上限は300秒なので、十分な余裕を取る)。
const STALE_PROCESSING_MS = 8 * 60 * 1000

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: extraction } = await (supabase as any)
    .from('extractions')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single() as { data: Extraction | null }

  if (!extraction) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (
    extraction.status === 'processing'
    && Date.now() - new Date(extraction.created_at).getTime() > STALE_PROCESSING_MS
  ) {
    const message = '抽出が時間内に完了しませんでした（実行時間の上限）。抽出件数を減らすか、条件を絞って再実行してください。'
    const admin = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    const { error } = await admin
      .from('extractions')
      .update({ status: 'failed', progress: 0, error_message: message })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('status', 'processing')
    if (!error) {
      extraction.status = 'failed'
      extraction.progress = 0
      extraction.error_message = message
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: products } = await (supabase as any)
    .from('products')
    .select('*')
    .eq('extraction_id', id)
    .order('created_at', { ascending: true }) as { data: Product[] | null }

  return NextResponse.json({ extraction, products: products ?? [] })
}
