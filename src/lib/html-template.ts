import type { SupabaseClient } from '@supabase/supabase-js'
import type { Product } from '@/types/database'

// 抽出設定「HTML設定」でアクティブにしたテンプレート(extraction_settings.
// html_template_id → html_templates.content)を読み込む。未設定なら null。
export async function loadActiveHtmlTemplate(db: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data: settings } = await db
      .from('extraction_settings')
      .select('html_template_id')
      .eq('user_id', userId)
      .maybeSingle()
    const templateId = settings?.html_template_id as string | null | undefined
    if (!templateId) return null
    const { data: template } = await db
      .from('html_templates')
      .select('content')
      .eq('id', templateId)
      .maybeSingle()
    const content = (template?.content as string | null | undefined)?.trim()
    return content ? content : null
  } catch {
    return null
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function textToHtml(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>')
}

// テンプレートの {{title}} {{original_title}} {{description}} {{condition}}
// {{price}} {{images}} {{image1}}.. を商品の値で置き換える。
// 以前は抽出時に置き換えて ebay_description に保存していたが、出力時
// (CSV/API出品/説明文の差し替え)に ebay_description(英訳済みの本文)を
// エスケープして埋め込むため、テンプレートのHTMLがそのまま文字として
// 表示されてしまう問題があった。出力時に適用する方式に変更。
export function renderDescriptionTemplate(template: string, product: Product): string {
  const images = product.ebay_images?.length ? product.ebay_images : (product.original_images ?? [])
  const imgTags = images.map((src) => `<img src="${escapeHtml(src)}" style="max-width:100%;margin:4px 0">`).join('\n')
  const description = product.ebay_description ?? product.original_description ?? ''
  const condition = product.ebay_condition ?? product.original_condition ?? ''
  const price = product.original_price
  return template
    .replace(/\{\{title\}\}/g, escapeHtml(product.ebay_title ?? product.original_title ?? ''))
    .replace(/\{\{original_title\}\}/g, escapeHtml(product.original_title ?? ''))
    .replace(/\{\{description\}\}/g, textToHtml(description))
    .replace(/\{\{condition\}\}/g, escapeHtml(condition))
    .replace(/\{\{price\}\}/g, price ? `¥${price.toLocaleString()}` : '')
    .replace(/\{\{images\}\}/g, imgTags)
    .replace(/\{\{image(\d+)\}\}/g, (_, n) => escapeHtml(images[parseInt(n) - 1] ?? ''))
}
