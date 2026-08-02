import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Extraction, Product } from '@/types/database'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { data: extraction } = await (supabase as any)
    .from('extractions')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single() as { data: Extraction | null }

  if (!extraction) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Vercelの最大実行時間を超えて強制終了されたジョブを、抽出中のまま残さない。
  const staleReference = Date.parse(extraction.updated_at || extraction.created_at)
  const isStale = extraction.status === 'processing'
    && Number.isFinite(staleReference)
    && Date.now() - staleReference > 8 * 60 * 1000

  if (isStale) {
    const errorMessage = '処理時間の上限を超えたため停止しました。通信状況を確認して再度抽出してください。'
    const now = new Date().toISOString()
    await (supabase as any)
      .from('extractions')
      .update({
        status: 'failed',
        progress: 0,
        error_message: errorMessage,
        updated_at: now,
      })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('status', 'processing')

    extraction = {
      ...extraction,
      status: 'failed',
      progress: 0,
      error_message: errorMessage,
      updated_at: now,
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
