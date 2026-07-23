export type PlanType = 'free' | 'basic' | 'pro' | 'enterprise'
export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type ListingStatus = 'draft' | 'listed' | 'sold' | 'delisted'
export type ProductPriceType = 'fixed' | 'auction'

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
}

export interface Product {
  id: string
  user_id: string
  extraction_id: string | null
  source_url: string
  source_site: string
  source_item_id: string | null
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
  ebay_condition: string | null
  ebay_category_id: string | null
  listing_status: ListingStatus
  listed_at: string | null
  sold_at: string | null
  seller_rating_count: number | null
  shipping_days: number | null
  source_updated_at: string | null
  purchase_price_jpy: number | null
  price_type: ProductPriceType
  created_at: string
  updated_at: string
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
      products: { Row: Product; Insert: ProductInsert; Update: Partial<Product> }
      scrapers: { Row: Scraper; Insert: ScraperInsert; Update: Partial<Scraper> }
    }
  }
}
