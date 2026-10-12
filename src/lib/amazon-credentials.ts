import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret } from '@/lib/secret-box'
import { MARKETPLACE_JP, type AmazonCredentials } from '@/lib/amazon-spapi'

export interface StoredAmazonCredentials extends AmazonCredentials {
  marketplaceId: string
}

/**
 * 保存済みのAmazon SP-API認証情報を復号して返す。
 * Next.jsのroute.tsはHTTPハンドラ以外をexportできないので、ここに置く。
 */
export async function loadAmazonCredentials(
  db: SupabaseClient,
  userId: string,
): Promise<StoredAmazonCredentials | null> {
  const { data, error } = await db
    .from('amazon_credentials')
    .select('client_id, client_secret_encrypted, refresh_token_encrypted, marketplace_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`Amazon認証情報の取得に失敗しました: ${error.message}`)
  if (!data) return null

  return {
    clientId: data.client_id as string,
    clientSecret: decryptSecret(data.client_secret_encrypted as string),
    refreshToken: decryptSecret(data.refresh_token_encrypted as string),
    marketplaceId: (data.marketplace_id as string | null) ?? MARKETPLACE_JP,
  }
}
