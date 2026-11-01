// ---------------------------------------------------------------------------
// 完成した出品CSVを、別の出品セラー・別サイト向けに作り変える。
//
// ユーザー要望(2026-11-01): miyabi-24(US)と akebono-32(UK)に同じ商品を出す際、
// 以下の工程を2回繰り返している。
//   Kakehashi CSV出力 → specifics-in 取込 → 画像DL → photoroom(白抜き)
//   → watermarkly(透かし) → specifics-in に画像を戻す → 不要画像を目視削除
//   → AIでタイトル・説明・Item Specifics を生成 → コンプライアンスチェック
//   → CSVダウンロード → eBayへアップロード
//
// このうちアカウントによって変わるのは透かしだけで、白抜き・目視削除・
// AI生成・コンプライアンスチェックは同じ結果になる(AI生成は料金も2倍になる)。
//
// Kakehashiから出し直すと、specifics-in で作ったタイトル・説明・Item Specifics
// が付いてこないため、結局そこからやり直しになる。そこで「完成したCSVを
// 受け取り、アカウントによって変わる列だけ差し替える」形にする。
// ---------------------------------------------------------------------------

// 差し替える列。これ以外(Title / Description / C:* / Category / PicURL など)は
// そのまま引き継ぐ。AI生成の結果を作り直さないことが目的なので、触らない。
const CUSTOM_LABEL_COLUMN = 'CustomLabel'
const START_PRICE_COLUMN = 'StartPrice'
const CURRENCY_COLUMN = 'Currency'
const SITE_ID_COLUMN = 'SiteID'
const PAYMENT_PROFILE_COLUMN = 'PaymentProfileName'
const RETURN_PROFILE_COLUMN = 'ReturnProfileName'
const SHIPPING_PROFILE_COLUMN = 'ShippingProfileName'

export interface ListingCsvReplacement {
  /** 差し替え後のCustomLabel(複製先の商品のもの) */
  customLabel: string
  /** 出品先サイトの通貨で計算した出品価格 */
  startPrice: number
}

export interface ListingCsvConvertOptions {
  siteId: string
  currency: string
  policies: { payment: string; return: string; shipping: string }
  /** 元のCustomLabel -> 差し替え後の値 */
  replacements: Map<string, ListingCsvReplacement>
}

export interface ListingCsvConvertResult {
  csv: string
  converted: number
  /** 複製先の商品が見つからず、出力しなかった行のCustomLabel */
  skipped: string[]
}

/**
 * CSVを行の配列に分解する(RFC4180)。
 * 商品説明にHTMLが入るため、引用符の中の改行とカンマを正しく扱う。
 */
export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  // BOMが付いたCSVは先頭の列名が一致しなくなるので落とす
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') { field += char; continue }
      if (text[index + 1] === '"') { field += '"'; index++; continue }
      quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === ',') { row.push(field); field = ''; continue }
    if (char === '\r') continue
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += char
  }
  // 最終行に改行が無い場合も取りこぼさない
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

/** 1行をCSVに戻す。引用符・カンマ・改行を含む値は必ず囲む。 */
export function toCsvLine(values: string[]): string {
  return values.map(value => `"${value.replace(/"/g, '""')}"`).join(',')
}

export function convertListingCsv(
  csv: string,
  options: ListingCsvConvertOptions,
): ListingCsvConvertResult {
  const rows = parseCsvRows(csv)
  if (rows.length < 2) throw new Error('CSVに行がありません')

  const headers = rows[0].map(header => header.trim())
  const indexOf = (column: string): number => headers.indexOf(column)
  const labelIndex = indexOf(CUSTOM_LABEL_COLUMN)
  if (labelIndex < 0) throw new Error(`${CUSTOM_LABEL_COLUMN} 列が見つかりません`)

  // 無い列は差し替えない(specifics-in の設定で列構成が変わることがある)
  const priceIndex = indexOf(START_PRICE_COLUMN)
  const currencyIndex = indexOf(CURRENCY_COLUMN)
  const siteIndex = indexOf(SITE_ID_COLUMN)
  const paymentIndex = indexOf(PAYMENT_PROFILE_COLUMN)
  const returnIndex = indexOf(RETURN_PROFILE_COLUMN)
  const shippingIndex = indexOf(SHIPPING_PROFILE_COLUMN)

  const out: string[] = [toCsvLine(rows[0])]
  const skipped: string[] = []
  let converted = 0

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]
    // 列数が足りない行(末尾の空行など)は飛ばす
    if (row.length <= labelIndex) continue
    const label = row[labelIndex].trim()
    if (!label) continue

    const replacement = options.replacements.get(label)
    if (!replacement) {
      // 複製先に対応する商品が無い行は出力しない。黙って元のCustomLabelのまま
      // 出すと、別アカウントの出品が同じ商品を指してしまう。
      skipped.push(label)
      continue
    }

    const values = [...row]
    // ヘッダより短い行でも、差し替える列まで届くように埋める
    while (values.length < headers.length) values.push('')

    values[labelIndex] = replacement.customLabel
    if (priceIndex >= 0) values[priceIndex] = replacement.startPrice.toFixed(2)
    if (currencyIndex >= 0) values[currencyIndex] = options.currency
    if (siteIndex >= 0) values[siteIndex] = options.siteId
    if (paymentIndex >= 0) values[paymentIndex] = options.policies.payment
    if (returnIndex >= 0) values[returnIndex] = options.policies.return
    if (shippingIndex >= 0) values[shippingIndex] = options.policies.shipping

    out.push(toCsvLine(values))
    converted++
  }

  return { csv: out.join('\r\n') + '\r\n', converted, skipped }
}
