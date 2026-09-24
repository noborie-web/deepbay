import type { SupabaseClient } from '@supabase/supabase-js'
import { findScraper, scrapeUrl } from '@/lib/scrapers'
import { fetchUsdJpyRate } from '@/lib/exchange-rate'
import { titleSimilarity } from '@/lib/supplier-match'
import { calculateAutomaticEbayPrice } from '@/lib/extraction-run'
import { calcModelPrice, calcPriceKeepingProfit, loadPricingModel, type PricingModel } from '@/lib/inventory-pricing'

// Yahoo!フリマの商品ページ取得上限(1回の実行あたり)。制限に達する前に止める。
const FLEA_SUPPLIER_CHECK_PER_RUN = 12

interface SupplierListingRow {
  id: string
  product_id: string
  ebay_item_id: string
}

// ユーザー要望: 公式ツールのように価格追従・差分検知の「結果」を実行ごとに
// 残し、CSV(revise / diff 形式)で出力できるようにする。1商品ごとの結果。
export interface SupplierCheckItemDetail {
  ebay_item_id: string
  product_id: string
  source_url: string | null
  outcome: 'available' | 'unavailable' | 'skipped'
  title_changed: boolean
  reserved: boolean
  old_title: string | null
  new_title: string | null
  purchase_price_before: number | null
  purchase_price_after: number | null
  // 価格追従で ebay_price を更新した場合の変更前後(USD)
  ebay_price_before: number | null
  ebay_price_after: number | null
  jpy_per_usd: number | null
}

interface SupplierProductRow {
  id: string
  source_url: string | null
  source_site: string | null
  original_title: string | null
  original_price: number | null
  purchase_price_jpy: number | null
  ebay_price: number | null
  pricing_jpy_per_usd: number | null
  extraction_id: string | null
}

// 公式ツールの「価格追従ファイル絞り込み設定」相当。
// direction: 'any' = 指定なし / 'up' = 値上がりのみ反映 / 'down' = 値下がりのみ反映
// thresholdRate: 検知差分率(%)。現在価格からの変動率がこれ以上のときだけ更新する。
export type PriceChangeDirection = 'any' | 'up' | 'down'
export interface PriceChangeFilter {
  direction: PriceChangeDirection
  thresholdRate: number
}
export const DEFAULT_PRICE_CHANGE_FILTER: PriceChangeFilter = { direction: 'any', thresholdRate: 1 }

export function normalizePriceChangeFilter(input: {
  price_change_direction?: unknown
  price_change_threshold_rate?: unknown
} | null | undefined): PriceChangeFilter {
  const direction = input?.price_change_direction
  const rate = input?.price_change_threshold_rate
  const parsedRate = typeof rate === 'string' ? Number(rate) : rate
  return {
    direction: direction === 'up' || direction === 'down' ? direction : 'any',
    thresholdRate: typeof parsedRate === 'number' && Number.isFinite(parsedRate) && parsedRate >= 0
      ? parsedRate
      : DEFAULT_PRICE_CHANGE_FILTER.thresholdRate,
  }
}

// ユーザー要望: 「出品した時点の為替の変動の差も検知して再計算して価格に
// 反映する」。再計算した価格と現在のeBay価格の差が検知差分率以上で、
// 差分検知タイプに合う方向のときだけ更新する。
export function shouldUpdateEbayPrice(
  currentPrice: number | null | undefined,
  recalculated: number,
  filter: PriceChangeFilter = DEFAULT_PRICE_CHANGE_FILTER,
): boolean {
  if (typeof currentPrice !== 'number' || !Number.isFinite(currentPrice) || currentPrice <= 0) return true
  const diffRate = (recalculated - currentPrice) / currentPrice * 100
  if (filter.direction === 'up' && diffRate <= 0) return false
  if (filter.direction === 'down' && diffRate >= 0) return false
  if (diffRate === 0) return false
  return Math.abs(diffRate) >= filter.thresholdRate
}

// 為替変動分だけを既存のeBay価格に反映する(出品時レート/現在レート倍)。
// 価格一括編集などで手動調整した価格も、その調整を維持したまま為替分だけ
// 動かせる。セント単位に丸める。
export function scalePriceByExchangeRate(currentPrice: number, pricingJpyPerUsd: number, currentJpyPerUsd: number): number {
  return Math.round(currentPrice * pricingJpyPerUsd / currentJpyPerUsd * 100) / 100
}

// calculateAutomaticEbayPriceのsettingパラメータ(AutoPricingSetting)は
// extraction-run.tsからexportされていないが、TypeScriptは構造的型付けの
// ため、同じ形のオブジェクトであれば呼び出し側でこの型を明示的に
// importしなくても渡せる。
interface BulkEditPricingSetting {
  profit_rate?: number | string | null
  ebay_fee_rate?: number | string | null
  shipping_cost_jpy?: number | string | null
  fixed_cost_usd?: number | string | null
}

export interface SupplierCheckResult {
  total: number
  available: number
  unavailable: number
  skipped: number
  failed: number
  // ユーザー要望: 「仕入れ価格の高騰に確実に対応できる在庫管理」。
  // 仕入れ元の現在価格が前回記録したpurchase_price_jpyより上がっていた
  // 場合、eBay出品価格(ebay_price)を再計算して自動的に更新した件数。
  // 実際にeBayへ反映するのは、この直後に実行される既存の「価格改定」
  // 自動実行(products.ebay_priceとinventory_active_listingsの現在価格
  // の差分を検知する仕組み)が担う — ここではDB上の計算値だけを更新する。
  price_increased: number
  // 仕入価格の変動・為替レートの変動により eBay価格(ebay_price)を
  // 再計算して更新した件数(price_increased を含む)。
  price_recalculated: number
  // ユーザー要望: 公式ツール同様にタイトルの差分も検知する。仕入先の最新
  // タイトルが抽出時(original_title)から変わっていた件数。
  title_changed: number
  // 仕入先URLが不明(eBayから復元したまま)のため仕入不可として在庫0にした件数
  no_supplier: number
  // 「〇〇様専用」等の取り置きになっていた件数(unavailable に含まれる)
  reserved: number
  // 取得エラー(429・ネットワーク等)で確認できなかった件数(skipped に含まれる)
  check_errors: number
  rate_limited: number
  // 安全網で適用しなかった値下げの件数(仕入価格が下がっていないのに15%超の値下げ)
  guarded: number
  // 仕入先のタイトルが変わったため取り下げ対象(在庫0)にした件数
  title_changed_delisted: number
  // 1商品ごとの結果(実行履歴のCSV出力用)
  items: SupplierCheckItemDetail[]
}

export type SupplierDiffKind = 'title' | 'price' | 'reserved' | 'title_replaced'

// ユーザー要望: メルカリでは購入者に取り置きするためタイトルを
// 「〇〇様専用」に変更する出品者がいる。この場合は他の人は買えないので
// 在庫切れと同じ扱い(在庫0 → 即取り下げ)にする。
const RESERVED_TITLE_PATTERNS = [
  /様\s*専用/,          // 〇〇様専用
  /専用\s*(出品|ページ|です|になります|$)/, // 専用出品 / 専用ページ / 「…専用」で終わる
  /^専用/,              // 専用〇〇様
  /お?取り?置き/,        // 取り置き / お取り置き / 取置き
  /取置/,
  /(purchased|reserved)\s*by/i,
]

export function isReservedTitle(title: string | null | undefined): boolean {
  if (!title) return false
  const normalized = title.replace(/\s+/g, ' ').trim()
  return RESERVED_TITLE_PATTERNS.some(pattern => pattern.test(normalized))
}

// 抽出時のタイトル・価格(円)と、仕入先の最新タイトル・価格を比べて差分の
// 種類を返す(公式ツールの差分検知ファイルの diff_detail 相当)。
// 本番で確認した誤検知(2026-09-23): 検索結果と商品ページでタイトルの空白が
// 異なる(全角/半角・連続空白)だけで「タイトル変更」と判定していた
// (例: 「FC エイトアイズ」と「FC  エイトアイズ」)。表記ゆれを吸収してから比べる。
export function normalizeSupplierTitle(title: string | null | undefined): string {
  return (title ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase()
}

// 本番で確認した誤検知(2026-09-24): 復元時に30文字で切れた元タイトルと、
// 仕入先の完全なタイトルを比べて「タイトル変更」と判定し、9件を誤って取り下げた。
// 「元タイトルが新タイトルの前方一致(切れている/語句が足された)」なら同じ商品とみなす。
// それ以外は、語句の大半が違う(類似度 < 0.7)か、仕入価格が急落(30%超)していれば
// 別商品への差し替えとみなして 'title_replaced'(取り下げ対象)にする。
// 実データの類似度: 切れている/語句追加=0.97、売り文句の変更(本日限定→SW特価)=0.73〜0.75、
// 別商品への差し替え(Cubic U…宇多田ヒカル ¥49,500 → Cubic U / Precious ¥400)=0.76だが価格が急落。
const TITLE_REPLACED_SIMILARITY = 0.7
const PURCHASE_COLLAPSE_RATIO = 0.7

export function isTitleReplaced(
  oldTitle: string | null | undefined,
  newTitle: string | null | undefined,
  prices?: { oldPriceJpy: number | null | undefined; newPriceJpy: number | null | undefined },
): boolean {
  const a = normalizeSupplierTitle(oldTitle)
  const b = normalizeSupplierTitle(newTitle)
  if (!a || !b || a === b) return false
  // 元タイトルが途中で切れている / 語句が足されただけ
  if (b.startsWith(a)) return false
  const priceCollapsed = typeof prices?.oldPriceJpy === 'number' && typeof prices?.newPriceJpy === 'number'
    && prices.oldPriceJpy > 0 && prices.newPriceJpy < prices.oldPriceJpy * PURCHASE_COLLAPSE_RATIO
  return titleSimilarity(a, b) < TITLE_REPLACED_SIMILARITY || priceCollapsed
}

export function detectSupplierDiff(
  original: { title: string | null; priceJpy: number | null },
  latest: { title: string | null | undefined; priceJpy: number | null | undefined },
): SupplierDiffKind[] {
  const diffs: SupplierDiffKind[] = []
  const originalTitle = (original.title ?? '').trim()
  const latestTitle = (latest.title ?? '').trim()
  if (originalTitle && latestTitle && normalizeSupplierTitle(originalTitle) !== normalizeSupplierTitle(latestTitle)) {
    diffs.push('title')
    // 別商品に差し替えられたとみられる場合だけ、取り下げの対象にする
    if (isTitleReplaced(originalTitle, latestTitle, { oldPriceJpy: original.priceJpy, newPriceJpy: latest.priceJpy })) diffs.push('title_replaced')
  }
  // 抽出時は専用ではなかったのに、今は「〇〇様専用」等になっている
  if (latestTitle && isReservedTitle(latestTitle) && !isReservedTitle(originalTitle)) diffs.push('reserved')
  if (
    typeof original.priceJpy === 'number' && typeof latest.priceJpy === 'number'
    && latest.priceJpy > 0 && Math.abs(original.priceJpy - latest.priceJpy) >= 1
  ) diffs.push('price')
  return diffs
}

export interface SupplierCheckOptions {
  // この時間(ms)を超えたら残りは次回に回す(cronの実行時間上限対策)。
  // 未チェックが古い順に処理するため、次回は残りから続きが確認される。
  timeBudgetMs?: number
  // 価格更新の絞り込み(差分検知タイプ・検知差分率)
  priceChangeFilter?: PriceChangeFilter
  // テスト用: ユーザーの価格モデル(未指定なら price_tier_settings から読む)
  pricingModel?: PricingModel
  // 対象を仕入先サイトで絞る(Yahoo!フリマ専用の高頻度チェック用)
  sourceSite?: string
  // 指定した仕入先サイトを対象から外す(フリマ以外の高頻度チェック用)
  excludeSourceSites?: string[]
  // ユーザー要望: 仕入先のタイトルが変わったら別商品に差し替えられた可能性が
  // 高いので、売り切れと同じく取り下げ対象(在庫0)にする。
  delistOnTitleChange?: boolean
}

export async function checkSupplierListings(
  db: SupabaseClient,
  userId: string,
  batchLimit = 50,
  options: SupplierCheckOptions = {},
): Promise<SupplierCheckResult> {
  const startedAt = Date.now()
  const result: SupplierCheckResult = {
    total: 0,
    available: 0,
    unavailable: 0,
    skipped: 0,
    failed: 0,
    price_increased: 0,
    price_recalculated: 0,
    title_changed: 0,
    reserved: 0,
    no_supplier: 0,
    check_errors: 0,
    rate_limited: 0,
    guarded: 0,
    title_changed_delisted: 0,
    items: [],
  }

  // sourceSite 指定時は商品テーブルを内部結合して仕入先サイトで絞る
  const needsProductJoin = Boolean(options.sourceSite) || (options.excludeSourceSites?.length ?? 0) > 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listingQuery: any = db
    .from('inventory_active_listings')
    .select(needsProductJoin ? 'id, product_id, ebay_item_id, products!inner(source_site)' : 'id, product_id, ebay_item_id')
    .eq('user_id', userId)
    .not('product_id', 'is', null)
    .gt('quantity', 0)
  if (options.sourceSite) listingQuery = listingQuery.eq('products.source_site', options.sourceSite)
  if (options.excludeSourceSites?.length) {
    listingQuery = listingQuery.not('products.source_site', 'in', `(${options.excludeSourceSites.join(',')})`)
  }
  const { data: listings, error: listingsError } = await listingQuery
    .order('supplier_checked_at', { ascending: true, nullsFirst: true })
    .limit(batchLimit)

  if (listingsError) {
    throw new Error(`Supplier listing lookup failed: ${listingsError.message}`)
  }

  const targets = (listings ?? []) as unknown as SupplierListingRow[]
  result.total = targets.length
  if (targets.length === 0) return result

  const productIds = Array.from(new Set(targets.map(listing => listing.product_id)))
  const { data: products, error: productsError } = await db
    .from('products')
    .select('id, source_url, source_site, original_title, original_price, purchase_price_jpy, ebay_price, pricing_jpy_per_usd, extraction_id')
    .eq('user_id', userId)
    .in('id', productIds)

  if (productsError) {
    throw new Error(`Supplier product lookup failed: ${productsError.message}`)
  }

  // 本番で確認した不具合(2026-09-22): numeric 型の列(purchase_price_jpy /
  // ebay_price / pricing_jpy_per_usd)は PostgREST から文字列で返るため、
  // `typeof === 'number'` の判定が常に false になり「出品時レート未記録」扱いで
  // 段階利益設定による再計算にフォールバックしていた(利益額維持が効かず、
  // 118件が提案Aの価格に書き換えられた)。数値に正規化してから使う。
  const toNumberOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null
    const n = typeof value === 'string' ? Number(value) : value
    return typeof n === 'number' && Number.isFinite(n) ? n : null
  }
  const productMap = new Map(
    ((products ?? []) as Array<Record<string, unknown>>).map(row => {
      const product: SupplierProductRow = {
        id: String(row.id),
        source_url: (row.source_url as string | null) ?? null,
        source_site: (row.source_site as string | null) ?? null,
        original_title: (row.original_title as string | null) ?? null,
        original_price: toNumberOrNull(row.original_price),
        purchase_price_jpy: toNumberOrNull(row.purchase_price_jpy),
        ebay_price: toNumberOrNull(row.ebay_price),
        pricing_jpy_per_usd: toNumberOrNull(row.pricing_jpy_per_usd),
        extraction_id: (row.extraction_id as string | null) ?? null,
      }
      return [product.id, product] as const
    }),
  )

  // 価格再計算に使う一括編集設定(利益率等)を抽出単位でまとめて取得する。
  // 設定が見つからない商品はcalculateAutomaticEbayPrice側のデフォルト
  // 利益設定にフォールバックする。
  const extractionIds = Array.from(new Set(
    ((products ?? []) as SupplierProductRow[])
      .map(p => p.extraction_id)
      .filter((id): id is string => Boolean(id)),
  ))
  const bulkSettingIdByExtractionId = new Map<string, string | null>()
  if (extractionIds.length > 0) {
    const { data: extractions } = await db
      .from('extractions')
      .select('id, bulk_edit_setting_id')
      .in('id', extractionIds)
    for (const e of extractions ?? []) bulkSettingIdByExtractionId.set(e.id, e.bulk_edit_setting_id)
  }
  const bulkSettingIds = Array.from(new Set(
    Array.from(bulkSettingIdByExtractionId.values()).filter((id): id is string => Boolean(id)),
  ))
  const bulkSettingMap = new Map<string, BulkEditPricingSetting>()
  if (bulkSettingIds.length > 0) {
    const { data: bulkSettings } = await db
      .from('bulk_edit_settings')
      .select('id, profit_rate, ebay_fee_rate, shipping_cost_jpy, fixed_cost_usd')
      .in('id', bulkSettingIds)
    for (const s of bulkSettings ?? []) bulkSettingMap.set(s.id, s)
  }

  // ユーザーが価格一括編集で保存した段階利益設定があれば、それを価格
  // モデルとして使う(仕入価格・為替の追従を手動設定と同じ式で行う)。
  const pricingModel = options.pricingModel !== undefined
    ? options.pricingModel
    : await loadPricingModel(db, userId).catch(() => null)

  // 為替レート取得に失敗しても売り切れチェック自体は継続する
  // (価格高騰への自動対応だけをスキップする)。
  let jpyPerUsd: number | null = null
  try {
    jpyPerUsd = (await fetchUsdJpyRate()).rate
  } catch {
    jpyPerUsd = null
  }

  const titleChangeDelist = options.delistOnTitleChange ?? false
  let fleaChecked = 0
  for (const listing of targets) {
    if (options.timeBudgetMs !== undefined && Date.now() - startedAt > options.timeBudgetMs) {
      result.skipped += 1
      continue
    }
    const checkedAt = new Date().toISOString()
    const product = productMap.get(listing.product_id)
    const sourceUrl = product?.source_url ?? null
    let outcome: 'available' | 'unavailable' | 'skipped' = 'skipped'
    let quantity: number | undefined
    let newPurchasePriceJpy: number | undefined
    let newEbayPrice: number | undefined
    let priceIncreased = false
    // 為替レートの基準だけを記録する(価格は変えない)場合に使う
    let baselineJpyPerUsd: number | undefined
    let baselinePurchasePriceJpy: number | undefined
    const priceChangeFilter = options.priceChangeFilter ?? DEFAULT_PRICE_CHANGE_FILTER
    // 仕入先の最新タイトル・価格と、抽出時からの差分
    let supplierTitle: string | null | undefined
    let supplierPriceJpy: number | null | undefined
    let supplierDiff: SupplierDiffKind[] | undefined
    let skipCheckedAtUpdate = false

    // Yahoo!フリマは商品ページの取得が約15件/15分/IPに制限される(実測)。1回の
    // 実行では FLEA_SUPPLIER_CHECK_PER_RUN 件だけ確認し、残りは次回に回す
    // (checked_at を更新しないので、次回は残りから順に確認される)。
    if (product?.source_site === 'yahoo_flea' && fleaChecked >= FLEA_SUPPLIER_CHECK_PER_RUN) {
      result.skipped += 1
      continue
    }
    if (product?.source_site === 'yahoo_flea') fleaChecked += 1

    if (product?.source_site === 'ebay') {
      // 実データで確認した不具合: eBayから復元した商品で仕入先URLが不明のもの
      // (仮のeBay URL)は「仕入先なし→取り下げ対象」として在庫0にしていたが、
      // 毎朝のeBay同期で在庫数がeBayの値(1)に戻り、仕入先チェックはskipped
      // のため取り下げられなかった。仕入先がない商品は毎回「仕入不可」として
      // 在庫0にし、取り下げ処理の対象にする。
      outcome = 'unavailable'
      quantity = 0
      result.no_supplier += 1
    } else if (sourceUrl && findScraper(sourceUrl)) {
      try {
        const scrapedProducts = await scrapeUrl(sourceUrl, { limit: 1 })
        const scraped = scrapedProducts[0] as { availability?: string; price?: number | null; title?: string | null } | undefined
        if (scraped && product) {
          supplierTitle = typeof scraped.title === 'string' && scraped.title.trim() ? scraped.title.trim() : null
          supplierPriceJpy = typeof scraped.price === 'number' && scraped.price > 0 ? scraped.price : null
          supplierDiff = detectSupplierDiff(
            { title: product.original_title, priceJpy: product.original_price },
            { title: supplierTitle, priceJpy: supplierPriceJpy },
          )
        }
        if (scraped?.availability === 'sold_out') {
          outcome = 'unavailable'
          quantity = 0
        } else if (supplierDiff?.includes('reserved')) {
          // 「〇〇様専用」等の取り置き: 他の人は買えないので在庫切れと同じ扱い
          outcome = 'unavailable'
          quantity = 0
        } else if (titleChangeDelist && supplierDiff?.includes('title_replaced')) {
          // ユーザー要望: 仕入先のタイトルが変わった = 別商品に差し替えられた
          // 可能性が高い(実データ: ¥49,500の宇多田ヒカルCDが「Cubic U / Precious」
          // ¥400 に差し替えられ、eBay価格が-81%になった)。売り切れと同じく
          // 在庫0にして取り下げ対象にし、価格の追従は行わない。
          outcome = 'unavailable'
          quantity = 0
          result.title_changed_delisted += 1
        } else {
          outcome = 'available'

          // 現在の仕入価格(取得できなければ前回記録した価格)を基に
          // eBay価格を見直す。
          //  - 仕入価格が変わった / 価格未設定 / 出品時レート未記録 →
          //    現在の仕入価格 × 現在の為替レートで計算式から再計算
          //  - 仕入価格が同じで出品時レートあり → 為替変動分だけ既存価格を
          //    スケール(手動調整した価格を維持)
          //  - 出品時レート未記録で価格あり・仕入価格同じ → 今回のレートを
          //    基準として記録するだけ(既存148件の初回チェック用。価格は変えない)
          const purchasePriceJpy = typeof scraped?.price === 'number' && scraped.price > 0
            ? scraped.price
            : product?.purchase_price_jpy ?? null
          if (jpyPerUsd !== null && product && purchasePriceJpy !== null) {
            const currentEbayPrice = typeof product.ebay_price === 'number' && product.ebay_price > 0
              ? product.ebay_price
              : null
            const pricingRate = typeof product.pricing_jpy_per_usd === 'number' && product.pricing_jpy_per_usd > 0
              ? product.pricing_jpy_per_usd
              : null
            // 本番で確認した不具合: 仕入価格(purchase_price_jpy)が未記録の商品を
            // 「仕入価格が変わった」とみなして計算式で再計算し、価格一括編集で
            // 設定済みのeBay価格を約20%低い値で上書きしてしまった。未記録の
            // 場合は変更なしとして扱い、今回の仕入価格・為替を基準として記録
            // するだけにする(eBay価格は変えない)。
            const purchasePriceChanged = typeof product.purchase_price_jpy === 'number'
              && Math.abs(purchasePriceJpy - product.purchase_price_jpy) >= 1

            let recalculated: number | null = null
            // 出品時の仕入価格(初回チェック前は抽出時の価格)
            const oldPurchasePriceJpy = typeof product.purchase_price_jpy === 'number' && product.purchase_price_jpy > 0
              ? product.purchase_price_jpy
              : (typeof product.original_price === 'number' && product.original_price > 0 ? product.original_price : null)
            if (pricingModel && currentEbayPrice !== null) {
              // ユーザー要望: 利益額維持は確実に効かせる。現在のeBay価格がある限り、
              // 出品時の利益額(円)を維持したまま仕入価格・為替の変動分だけ動かす
              // (価格一括編集で選んだプリセットや手動調整を、保存中の段階利益設定で
              //  上書きしない)。出品時レートが未記録なら今回のレート(=為替変動なし)、
              // 出品時の仕入価格が未記録なら今回の仕入価格(=仕入変動なし)とみなす。
              // 段階利益設定での再計算は「eBay価格そのものが無い」場合だけ。
              recalculated = calcPriceKeepingProfit(
                pricingModel,
                currentEbayPrice,
                oldPurchasePriceJpy ?? purchasePriceJpy,
                pricingRate ?? jpyPerUsd,
                purchasePriceJpy,
                jpyPerUsd,
              )
              // 出品時レート/仕入価格が未記録なら、今回の値を基準として記録する
              // (価格を変えない場合でも次回以降の追従の基準になる)
              if (pricingRate === null) baselineJpyPerUsd = jpyPerUsd
              if (typeof product.purchase_price_jpy !== 'number') baselinePurchasePriceJpy = purchasePriceJpy
            } else if (pricingModel) {
              recalculated = calcModelPrice(pricingModel, purchasePriceJpy, jpyPerUsd)
            } else if (purchasePriceChanged || currentEbayPrice === null) {
              const bulkSettingId = product.extraction_id
                ? bulkSettingIdByExtractionId.get(product.extraction_id)
                : null
              const setting = bulkSettingId ? bulkSettingMap.get(bulkSettingId) : null
              recalculated = calculateAutomaticEbayPrice(purchasePriceJpy, jpyPerUsd, setting)
            } else if (pricingRate !== null) {
              recalculated = scalePriceByExchangeRate(currentEbayPrice, pricingRate, jpyPerUsd)
            } else {
              baselineJpyPerUsd = jpyPerUsd
              if (typeof product.purchase_price_jpy !== 'number') baselinePurchasePriceJpy = purchasePriceJpy
            }

            // 安全網(ユーザー要望「赤字になるのは絶対に避けて」): 仕入価格が下がって
            // いないのに 15% を超える値下げになる再計算は、ロジックの不具合とみなして
            // 適用しない(記録だけ残す)。
            const purchaseDecreased = oldPurchasePriceJpy !== null && purchasePriceJpy < oldPurchasePriceJpy - 1
            // 仕入価格が急落(30%超)した場合は、別商品への差し替え・取得ミスの
            // 可能性が高いので自動反映しない(実データ: ¥49,500 → ¥400)
            const purchaseCollapsed = oldPurchasePriceJpy !== null && purchasePriceJpy < oldPurchasePriceJpy * 0.7
            if (recalculated !== null && purchaseCollapsed) {
              console.warn(`[supplier-check] guarded (purchase collapsed): ${listing.ebay_item_id} ${oldPurchasePriceJpy} -> ${purchasePriceJpy}`)
              result.guarded += 1
              recalculated = null
              newPurchasePriceJpy = undefined
            }
            if (recalculated !== null && currentEbayPrice !== null && !purchaseDecreased && recalculated < currentEbayPrice * 0.85) {
              console.warn(`[supplier-check] guarded: ${listing.ebay_item_id} ${currentEbayPrice} -> ${recalculated} (purchase ${oldPurchasePriceJpy} -> ${purchasePriceJpy}, rate ${pricingRate} -> ${jpyPerUsd})`)
              result.guarded += 1
              recalculated = null
            }
            if (recalculated !== null && shouldUpdateEbayPrice(currentEbayPrice, recalculated, priceChangeFilter)) {
              newPurchasePriceJpy = purchasePriceJpy
              newEbayPrice = recalculated
              if (
                typeof product.purchase_price_jpy === 'number'
                && purchasePriceJpy > product.purchase_price_jpy
              ) priceIncreased = true
            }
          }
        }
      } catch (error) {
        // 本番で確認した不具合(2026-09-22): Yahoo!フリマの商品ページが429(アクセス
        // 過多)で取得できなかった64件を「ページ削除=売り切れ」と判定し、eBayの在庫を
        // 0にしてしまった。ページが無いと確定できる 404/410 だけを削除(売り切れ)と
        // みなし、429・5xx・ネットワークエラー等は「未確認」にして次回に回す。
        const message = error instanceof Error ? error.message : String(error)
        if (/(HTTP|error:) (404|410)\b/.test(message)) {
          outcome = 'unavailable'
          quantity = 0
        } else {
          outcome = 'skipped'
          result.check_errors += 1
          if (/HTTP 429\b/.test(message)) result.rate_limited += 1
          // 未確認のまま supplier_checked_at を更新すると次回の対象順が後ろに回る。
          // 429で全く見られていないものは checked_at を更新せず、次回も先に確認する。
          skipCheckedAtUpdate = /HTTP 429\b/.test(message)
        }
      }
    }

    const update: {
      supplier_checked_at: string
      quantity?: number
      supplier_title?: string | null
      supplier_price_jpy?: number | null
      supplier_diff?: SupplierDiffKind[]
      supplier_diff_detected_at?: string | null
    } = {
      supplier_checked_at: checkedAt,
    }
    if (skipCheckedAtUpdate) {
      // 429で確認できなかった: 何も更新せず次回に回す(結果には skipped として数える)
      result.skipped += 1
      continue
    }
    if (quantity !== undefined) update.quantity = quantity
    if (supplierDiff !== undefined) {
      update.supplier_title = supplierTitle ?? null
      update.supplier_price_jpy = supplierPriceJpy ?? null
      update.supplier_diff = supplierDiff
      update.supplier_diff_detected_at = supplierDiff.length > 0 ? checkedAt : null
    }

    try {
      const { error: updateError } = await db
        .from('inventory_active_listings')
        .update(update)
        .eq('user_id', userId)
        .eq('id', listing.id)
      if (updateError) throw new Error(updateError.message)
      result[outcome] += 1
      if (supplierDiff?.includes('title')) result.title_changed += 1
      if (supplierDiff?.includes('reserved')) result.reserved += 1
      result.items.push({
        ebay_item_id: listing.ebay_item_id,
        product_id: listing.product_id,
        source_url: sourceUrl,
        outcome,
        title_changed: supplierDiff?.includes('title') ?? false,
        reserved: supplierDiff?.includes('reserved') ?? false,
        old_title: product?.original_title ?? null,
        new_title: supplierTitle ?? null,
        purchase_price_before: product?.purchase_price_jpy ?? product?.original_price ?? null,
        purchase_price_after: supplierPriceJpy ?? null,
        ebay_price_before: newEbayPrice !== undefined ? (product?.ebay_price ?? null) : null,
        ebay_price_after: newEbayPrice ?? null,
        jpy_per_usd: jpyPerUsd,
      })
    } catch {
      // 1件の更新失敗で、残りの仕入れ元チェックを中断しない。
      result.failed += 1
      continue
    }

    if (newPurchasePriceJpy !== undefined && newEbayPrice !== undefined) {
      try {
        const { error: productUpdateError } = await db
          .from('products')
          // 更新後の価格は現在のレートで計算した値なので、基準レートも更新する
          .update({ purchase_price_jpy: newPurchasePriceJpy, ebay_price: newEbayPrice, pricing_jpy_per_usd: jpyPerUsd })
          .eq('user_id', userId)
          .eq('id', listing.product_id)
        if (productUpdateError) throw new Error(productUpdateError.message)
        result.price_recalculated += 1
        if (priceIncreased) result.price_increased += 1
      } catch {
        // 価格更新の失敗は売り切れチェック(available/unavailable判定)の
        // 成否とは独立して扱い、failedとしては数えない。
      }
    } else if (baselineJpyPerUsd !== undefined) {
      try {
        await db
          .from('products')
          .update(
            baselinePurchasePriceJpy !== undefined
              ? { pricing_jpy_per_usd: baselineJpyPerUsd, purchase_price_jpy: baselinePurchasePriceJpy }
              : { pricing_jpy_per_usd: baselineJpyPerUsd },
          )
          .eq('user_id', userId)
          .eq('id', listing.product_id)
      } catch {
        // 基準レートの記録失敗は次回のチェックで再試行される
      }
    }
  }

  return result
}
