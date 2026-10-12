import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

// eBayのリフレッシュトークン暗号化(src/lib/ebay.ts)と同じ方式を、
// 他の認証情報(Amazon SP-APIのCLIENT_SECRET / REFRESH_TOKEN等)でも使えるように
// 切り出したもの。鍵は既存の EBAY_TOKEN_ENCRYPTION_KEY を共用する
// (新しい環境変数を増やすと、設定漏れで本番だけ動かない事故が起きるため)。
function getEncryptionKey(): Buffer {
  const raw = (process.env.TOKEN_ENCRYPTION_KEY ?? process.env.EBAY_TOKEN_ENCRYPTION_KEY ?? '').trim()
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY（または EBAY_TOKEN_ENCRYPTION_KEY）が未設定です')

  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('暗号鍵は32バイトのBase64値にしてください')
  }
  return key
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptSecret(encrypted: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = encrypted.split('.')
  if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('保存済み認証情報の形式が不正です')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivValue, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/** 画面表示用に、先頭と末尾だけ残して伏せる。 */
export function maskSecret(value: string, visible = 4): string {
  const trimmed = value.trim()
  if (trimmed.length <= visible * 2) return '*'.repeat(trimmed.length)
  return `${trimmed.slice(0, visible)}${'*'.repeat(8)}${trimmed.slice(-visible)}`
}
