export type DangerSettingsCsvKind = 'sellers' | 'words' | 'replaces'

interface SellerRow { seller_url: string }
interface WordRow { word: string }
interface ReplaceRow { before_word: string; after_word: string }

export interface DangerSettingsCsvData {
  sellers?: SellerRow[]
  words?: WordRow[]
  replaces?: ReplaceRow[]
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function buildDangerSettingsCsv(
  kind: DangerSettingsCsvKind,
  data: DangerSettingsCsvData,
): { filename: string; content: string; count: number } {
  if (kind === 'sellers') {
    const rows = data.sellers ?? []
    return {
      filename: 'danger_sellers.csv',
      content: `\uFEFFseller_url\r\n${rows.map((row) => csvCell(row.seller_url)).join('\r\n')}`,
      count: rows.length,
    }
  }

  if (kind === 'words') {
    const rows = data.words ?? []
    return {
      filename: 'danger_words.csv',
      content: `\uFEFFword\r\n${rows.map((row) => csvCell(row.word)).join('\r\n')}`,
      count: rows.length,
    }
  }

  const rows = data.replaces ?? []
  return {
    filename: 'replace_words.csv',
    content: `\uFEFFbefore_word,after_word\r\n${rows.map((row) => (
      `${csvCell(row.before_word)},${csvCell(row.after_word)}`
    )).join('\r\n')}`,
    count: rows.length,
  }
}
