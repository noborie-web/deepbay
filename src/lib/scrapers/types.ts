export interface ScrapedProduct {
  sourceUrl: string
  sourceSite: string
  sourceItemId: string | null
  title: string
  price: number | null
  description: string
  images: string[]
  condition: string | null
  category: string | null
  sellerRatingCount: number | null  // 評価数
  shippingDays: number | null       // 発送日数（最短日数）
  sourceUpdatedAt: string | null    // 最終更新日（ISO文字列）
  availability?: 'available' | 'sold_out' | 'unknown'
  // 出品者のプロフィールURL(危険セラー除外の個別商品判定に使う)。
  // 取得できないサイト/経路ではundefined/nullのままでよく、その場合は
  // 個別商品単位の危険セラー除外は行われない(既存の「抽出URL自体が
  // 危険セラーのページである場合」のチェックのみ有効)。
  sellerUrl?: string | null
}

export interface ScraperOptions {
  userAgent?: string
  timeoutMs?: number
  limit?: number  // 取得件数上限
  onPage?: (fetched: number, total: number) => void  // ページ取得後コールバック
  // 危険セラー除外のため、検索結果一覧でも商品ごとの出品者URLを取得する。
  // サイトによっては検索結果に出品者情報が含まれず、商品ごとに追加の
  // ページアクセスが必要になる(ラクマ等)。呼び出し側(抽出パイプライン)が
  // 危険セラーが1件も登録されていない場合はfalseのままにして、不要な
  // 追加アクセスを避ける。
  fetchSellerInfo?: boolean
}

export interface IScraper {
  name: string
  siteKey: string
  urlPattern: RegExp
  matches?(url: string): boolean
  // 単品 or 複数を統一してリストで返す
  scrape(url: string, options?: ScraperOptions): Promise<ScrapedProduct[]>
}

export class ScraperError extends Error {
  constructor(
    message: string,
    public readonly siteKey: string,
    public readonly url: string,
  ) {
    super(message)
    this.name = 'ScraperError'
  }
}
