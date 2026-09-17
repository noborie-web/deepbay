import type { Product } from '@/types/database'

// 説明文に日本語(ひらがな・カタカナ・漢字)が含まれているか。出品済み商品の
// 説明文が未翻訳(日本語のまま)かどうかの判定に使う。
export const JAPANESE_PATTERN = /[぀-ヿ㐀-鿿]/

export function hasJapaneseDescription(product: Pick<Product, 'ebay_description' | 'original_description'>): boolean {
  const text = product.ebay_description ?? product.original_description ?? ''
  if (!JAPANESE_PATTERN.test(text)) return false
  // 曲名など一部に日本語が残る翻訳済みの説明文は「未翻訳」とみなさない
  return !checkTranslatedDescription(text).ok
}

// 本番で確認した不具合: 翻訳結果に日本語が1文字でも残っていると失敗扱いに
// していたため、曲名・アルバム名を日本語で残す正しい翻訳(例:「月下の夜想曲」)
// が7件失敗した。日本語の割合が小さく、国内配送などの禁止語が無ければ
// 翻訳成功とみなす。
const JAPANESE_CHARS_GLOBAL = /[\u3040-\u30ff\u3400-\u9fff]/g
const MAX_JAPANESE_RATIO = 0.2
const DOMESTIC_ONLY_WORDS = /ゆうパック|ヤマト|佐川|クリックポスト|ネコポス|ゆうパケット|メルカリ便|匿名配送|送料込み|送料無料|翌月払い|即購入|専用|取り置き|取置|プロフ|コメント逃げ|値下げ交渉|神経質な方/

export type TranslationCheck = { ok: true } | { ok: false; reason: string }

export function checkTranslatedDescription(text: string): TranslationCheck {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: '翻訳結果が空です' }
  const domestic = trimmed.match(DOMESTIC_ONLY_WORDS)
  if (domestic) return { ok: false, reason: `国内向けの文言が残っています: ${domestic[0]}` }
  const japaneseCount = (trimmed.match(JAPANESE_CHARS_GLOBAL) ?? []).length
  const ratio = japaneseCount / trimmed.length
  if (ratio > MAX_JAPANESE_RATIO) return { ok: false, reason: `日本語が多く残っています(${Math.round(ratio * 100)}%)` }
  return { ok: true }
}
