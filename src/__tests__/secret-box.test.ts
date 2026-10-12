import { beforeEach, describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, maskSecret } from '@/lib/secret-box'

// Amazon SP-APIのCLIENT_SECRET / REFRESH_TOKEN を保存するために、eBayの
// トークン暗号化と同じ方式(AES-256-GCM)を切り出したもの。
// 既存のPythonツールでは認証情報がソース直書きだったので、ここでは必ず暗号化する。
describe('認証情報の暗号化', () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  })

  it('暗号化して復号すると元に戻る', () => {
    const secret = 'Atzr|IwEBIExample-Refresh-Token'
    expect(decryptSecret(encryptSecret(secret))).toBe(secret)
  })

  it('毎回違う暗号文になる（同じ値でも推測されにくい）', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('改ざんされた暗号文は復号に失敗する', () => {
    const encrypted = encryptSecret('secret')
    const broken = `${encrypted.slice(0, -4)}AAAA`
    expect(() => decryptSecret(broken)).toThrow()
  })

  it('形式が違えば分かるエラーを出す', () => {
    expect(() => decryptSecret('not-encrypted')).toThrow(/形式が不正/)
  })

  it('鍵が未設定なら保存させない', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY
    delete process.env.EBAY_TOKEN_ENCRYPTION_KEY
    expect(() => encryptSecret('x')).toThrow(/未設定/)
  })

  it('画面表示用に前後だけ残して伏せる', () => {
    expect(maskSecret('amzn1.application-oa2-client.abcdef')).toBe('amzn********cdef')
    // 短い値は全部伏せる
    expect(maskSecret('abc')).toBe('***')
  })
})
