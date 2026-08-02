export type PlanType = 'free' | 'basic' | 'pro' | 'enterprise'
export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'excluded'
export type ListingStatus = 'draft' | 'listing' | 'listed' | 'sold' | 'delisted'
export type ProductPriceType = 'fixed' | 'auction'
export type ExtractionActivityType =
  | 'edited'
  | 'csv_exported'
  | 'specifics_csv_exported'
  | 'direct_listed'
  | 'excluded'

export interface Profile {
  id: string
  email: string
  display_name: string | null
  plan: PlanType
  extraction_limit: number
  extraction_used: number
  plan_reset_at: string
  created_at: string
  updated_at: string
}

export interface SellerAccount {
  id: string
  user_id: string
  seller_id: string
  display_name: string | null
  is_default: boolean
  ebay_user_id?: string | null
  ebay_marketplace_id?: string
  ebay_connected_at?: string | null
  created_at: string
}

export interface ListingCategory {
  id: string
  user_id: string
  name: string
  ebay_category_id: string | null
  sort_order: number
  created_at: string
}

export interface BulkEditSetting {
  id: string
  user_id: string
  name: string
  price_rate: number
  title_prefix: string
  title_suffix: string
  description_template: string
  condition_mapping: Record<string, string>
  memo: string
  is_default: boolean
  config: import('@/lib/bulk-edit-settings').BulkEditConfig
  created_at: string
  updated_at: string
}

export interface Extraction {
  id: string
  user_id: string
  source_url: string
  source_site: string
  seller_account_id: string | null
  category_id: string | null
  bulk_edit_setting_id: string | null
  status: ExtractionStatus
  progress: number
  memo: string
  is_bulk: boolean
  extracted_at: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  // joins
  seller_account?: SellerAccount
  category?: ListingCategory
  bulk_edit_setting?: BulkEditSetting
  products?: Product[]
  activities?: ExtractionActivity[]
}

export interface ExtractionActivity {
  id: string
  extraction_id: string
  user_id: string
  activity_type: ExtractionActivityType
  label: string
  item_count: number
  metadata: Record<string, unknown>
  created_at: string
}

export interface ExcludedProduct {
  id: string
  extraction_id: string
  user_id: string
  product_id: string
  reason_code: string
  reason_label: string
  source_url: string
  original_title: string
  original_price: number | null
  image_url: string | null
  metadata: Record<string, unknown>
  excluded_at: string
}

export interface Product {
  id: string
  user_id: string
  extraction_id: string | null
  source_url: string
  source_site: string
  source_item_id: string | null
  source_seller_id?: string | null
  source_seller_url?: string | null
  original_title: string
  original_price: number | null
  original_description: string | null
  original_images: string[]
  original_condition: string | null
  ebay_title: string | null
  ebay_brand: string | null
  ebay_price: number | null
  ebay_description: string | null
  ebay_images: string[]
  ebay_item_specifics: Record<string, string[]>
  ebay_condition: string | null
  ebay_category_id: string | null
  listing_status: ListingStatus
  ebay_item_id?: string | null
  listed_at: string | null
  sold_at: string | null
  seller_rating_count: number | null
  shipping_days: number | null
  source_updated_at: string | null
  purchase_price_jpy: number | null
  price_type: ProductPriceType
  source_lookup_code?: string | null
  created_at: string
  updated_at: string
}

export interface SourceUrlLookupCode {
  id: string
  user_id: string
  product_id: string | null
  lookup_code: string
  source_url: string
  source_site: string
  source_title: string
  created_at: string
}

export interface Scraper {
  id: string
  name: string
  site_key: string
  url_pattern: string
  is_active: boolean
  notes: string
  created_at: string
}

// Insert types (required fields only, rest optional)
export type ProfileInsert = Pick<Profile, 'id' | 'email'> & Partial<Profile>
export type SellerAccountInsert = Pick<SellerAccount, 'user_id' | 'seller_id'> & Partial<SellerAccount>
export type ListingCategoryInsert = Pick<ListingCategory, 'user_id' | 'name'> & Partial<ListingCategory>
export type BulkEditSettingInsert = Pick<BulkEditSetting, 'user_id' | 'name'> & Partial<BulkEditSetting>
export type ExtractionInsert = Pick<Extraction, 'user_id' | 'source_url' | 'source_site'> & Partial<Extraction>
export type ExtractionActivityInsert =
  Pick<ExtractionActivity, 'extraction_id' | 'user_id' | 'activity_type' | 'label'>
  & Partial<ExtractionActivity>
export type ExcludedProductInsert =
  Pick<
    ExcludedProduct,
    'extraction_id' | 'user_id' | 'product_id' | 'reason_code' | 'reason_label'
    | 'source_url' | 'original_title'
  >
  & Partial<ExcludedProduct>
export type ProductInsert = Pick<Product, 'user_id' | 'source_url' | 'source_site' | 'original_title'> & Partial<Product>
export type ScraperInsert = Pick<Scraper, 'name' | 'site_key' | 'url_pattern'> & Partial<Scraper>

export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: ProfileInsert; Update: Partial<Profile> }
      seller_accounts: { Row: SellerAccount; Insert: SellerAccountInsert; Update: Partial<SellerAccount> }
      listing_categories: { Row: ListingCategory; Insert: ListingCategoryInsert; Update: Partial<ListingCategory> }
      bulk_edit_settings: { Row: BulkEditSetting; Insert: BulkEditSettingInsert; Update: Partial<BulkEditSetting> }
      extractions: { Row: Extraction; Insert: ExtractionInsert; Update: Partial<Extraction> }
      extraction_activities: {
        Row: ExtractionActivity
        Insert: ExtractionActivityInsert
        Update: Partial<ExtractionActivity>
      }
      excluded_products: {
        Row: ExcludedProduct
        Insert: ExcludedProductInsert
        Update: Partial<ExcludedProduct>
      }
      products: { Row: Product; Insert: ProductInsert; Update: Partial<Product> }
      source_url_lookup_codes: {
        Row: SourceUrlLookupCode
        Insert: Omit<SourceUrlLookupCode, 'id' | 'created_at'>
        Update: Partial<SourceUrlLookupCode>
      }
      scrapers: { Row: Scraper; Insert: ScraperInsert; Update: Partial<Scraper> }
    }
  }
}
