import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptEbayRefreshToken, refreshEbayAccessToken } from './ebay'
import { resolveAccessToken } from './ebay-actions'

export interface InventoryAuthSettings {
  ebay_token?: string | null
  ebay_refresh_token?: string | null
  ebay_token_expires_at?: string | null
}

async function connectedCredentials(db: SupabaseClient, userId: string) {
  const { data, error } = await db
    .from('ebay_account_credentials')
    .select('refresh_token_encrypted')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(2)

  if (error) throw new Error(`eBay接続情報の取得に失敗しました: ${error.message}`)
  return data ?? []
}

export async function hasInventoryAuthentication(
  db: SupabaseClient,
  userId: string,
  legacyAccessToken?: string | null,
): Promise<boolean> {
  if (legacyAccessToken) return true
  return (await connectedCredentials(db, userId)).length === 1
}

export async function resolveInventoryAccessToken(
  db: SupabaseClient,
  userId: string,
  settings: InventoryAuthSettings,
): Promise<string> {
  const credentials = await connectedCredentials(db, userId)

  if (credentials.length === 1) {
    const refreshToken = decryptEbayRefreshToken(credentials[0].refresh_token_encrypted)
    return refreshEbayAccessToken(refreshToken)
  }

  if (credentials.length > 1 && !settings.ebay_token) {
    throw new Error('複数のeBayセラーが接続されています。在庫管理で使用するセラーを選択してください')
  }
  if (!settings.ebay_token) throw new Error('eBayアカウントが接続されていません')

  return resolveAccessToken({
    ebay_token: settings.ebay_token,
    ebay_refresh_token: settings.ebay_refresh_token,
    ebay_token_expires_at: settings.ebay_token_expires_at,
  }, async refreshed => {
    const { error } = await db.from('inventory_settings').update({
      ebay_token: refreshed.accessToken,
      ebay_token_expires_at: refreshed.expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('user_id', userId)
    if (error) throw new Error(`更新トークンの保存に失敗しました: ${error.message}`)
  })
}
