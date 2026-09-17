import type { Product } from '@/types/database'

// 説明文に日本語(ひらがな・カタカナ・漢字)が含まれているか。出品済み商品の
// 説明文が未翻訳(日本語のまま)かどうかの判定に使う。
export const JAPANESE_PATTERN = /[぀-ヿ㐀-鿿]/

export function hasJapaneseDescription(product: Pick<Product, 'ebay_description' | 'original_description'>): boolean {
  const text = product.ebay_description ?? product.original_description ?? ''
  return JAPANESE_PATTERN.test(text)
}
