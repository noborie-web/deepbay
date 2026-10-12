import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { encryptSecret, maskSecret } from '@/lib/secret-box'
import { AmazonAuthError, fetchAccessToken, MARKETPLACE_JP } from '@/lib/amazon-spapi'

// ユーザー要望(2026-10-12): Amazon.co.jpを仕入先にする。SP-APIのLWA認証情報を
// 保存する。保存前に実際にアクセストークンを取得して、通らない情報は保存しない
// (あとで抽出が動かない原因が認証なのか別なのか分からなくなるため)。
function admin() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await admin()
    .from('amazon_credentials')
    .select('client_id, marketplace_id, verified_at, last_error, connected_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ connected: false })

  return NextResponse.json({
    connected: true,
    // 秘密情報は返さない。確認用に一部だけ伏せ字で出す
    client_id_masked: maskSecret(data.client_id as string),
    marketplace_id: data.marketplace_id,
    verified_at: data.verified_at,
    last_error: data.last_error,
    connected_at: data.connected_at,
    updated_at: data.updated_at,
  })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSONを解釈できませんでした' }, { status: 400 })
  }

  const clientId = requiredString(body.clientId)
  const clientSecret = requiredString(body.clientSecret)
  const refreshToken = requiredString(body.refreshToken)
  const marketplaceId = requiredString(body.marketplaceId) ?? MARKETPLACE_JP
  if (!clientId || !clientSecret || !refreshToken) {
    return NextResponse.json(
      { error: 'クライアントID・クライアントシークレット・リフレッシュトークンをすべて入力してください' },
      { status: 400 },
    )
  }

  // 保存前に実際に認証してみる
  try {
    await fetchAccessToken({ clientId, clientSecret, refreshToken })
  } catch (error) {
    const message = error instanceof AmazonAuthError ? error.message : 'Amazonの認証に失敗しました'
    return NextResponse.json({ error: message }, { status: 422 })
  }

  const now = new Date().toISOString()
  const { error } = await admin()
    .from('amazon_credentials')
    .upsert({
      user_id: user.id,
      client_id: clientId,
      client_secret_encrypted: encryptSecret(clientSecret),
      refresh_token_encrypted: encryptSecret(refreshToken),
      marketplace_id: marketplaceId,
      verified_at: now,
      last_error: null,
      updated_at: now,
    }, { onConflict: 'user_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, connected: true, verified_at: now })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await admin().from('amazon_credentials').delete().eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, connected: false })
}
