import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveInventoryAccessToken, resolveSellerAccountAccessToken, type InventoryAuthSettings } from './inventory-auth'
import { listInventorySellerAccounts, type InventorySellerAccount } from './inventory-seller-accounts'

// ユーザー要望(2026-09-25): 出品アカウントを複数運用し、在庫管理はアカウント
// ごとに独立させる。「混在しないよう細心の注意が必要」とのことなので、出品を
// 操作するときは必ずその出品を出したセラーのトークンを使う。どのセラーの出品
// か特定できない行は、セラーが1つのときだけ従来どおり扱い、複数運用時は操作
// しない(他アカウントの出品を誤って取り下げ・値下げしないため)。
export interface InventoryTokenResolver {
  accounts: InventorySellerAccount[]
  // 出品行の seller_account_id に対応するトークン(操作してよい場合のみ)
  tokenFor(sellerAccountId: string | null | undefined): string | null
  // セラーを指定しない処理(同期の入口など)で使う代表トークン
  defaultToken: string | null
  authErrors: Array<{ seller_id: string; error: string }>
}

export async function createInventoryTokenResolver(
  db: SupabaseClient,
  userId: string,
  settings: InventoryAuthSettings,
): Promise<InventoryTokenResolver> {
  const accounts = await listInventorySellerAccounts(db, userId)
  const tokens = new Map<string, string>()
  const authErrors: Array<{ seller_id: string; error: string }> = []

  for (const account of accounts) {
    try {
      tokens.set(account.id, await resolveSellerAccountAccessToken(db, userId, account.id))
    } catch (error) {
      authErrors.push({ seller_id: account.seller_id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const connected = accounts.filter(account => tokens.has(account.id))
  let defaultToken: string | null = connected.length > 0 ? tokens.get(connected[0].id)! : null
  if (defaultToken === null) {
    // 出品アカウント経由の接続が1件も無い場合だけ、従来の単一トークンで動かす
    defaultToken = await resolveInventoryAccessToken(db, userId, settings)
  }

  return {
    accounts: connected,
    authErrors,
    defaultToken,
    tokenFor(sellerAccountId) {
      if (sellerAccountId) return tokens.get(sellerAccountId) ?? null
      return connected.length <= 1 ? defaultToken : null
    },
  }
}
