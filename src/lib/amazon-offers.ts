// 既存のPythonツール(spapi_prima_bulk_fast_real.py)が実データで踏んだ落とし穴を
// そのまま移植したオファー選定ロジック。無在庫の仕入判断に直結するので、
// ここを雑にすると「実際には買えない価格」で出品してしまう。

/** カートボックス価格のこの割合未満なら、一般には購入できないオファーとみなす */
export const UNBUYABLE_PRICE_RATIO = 0.5

export interface SpApiMoney { Amount?: number | string; CurrencyCode?: string }

export interface SpApiOffer {
  SubCondition?: string
  Condition?: string
  ListingPrice?: SpApiMoney
  Shipping?: SpApiMoney
  IsFulfilledByAmazon?: boolean
  IsBuyBoxWinner?: boolean
}

export interface SpApiOffersPayload {
  ASIN?: string
  Offers?: SpApiOffer[]
  Summary?: {
    BuyBoxPrices?: Array<{ condition?: string; ListingPrice?: SpApiMoney }>
    TotalOfferCount?: number
  }
}

export interface PickedOffer {
  /** 本体価格(円)。送料は含まない */
  listingPriceJpy: number
  shippingJpy: number
  isFba: boolean
  /** 一般に購入できないと判断して除外した件数(調査用) */
  excludedUnbuyable: number
  offerCount: number
}

function toNumber(money: SpApiMoney | undefined): number | null {
  const raw = money?.Amount
  const value = typeof raw === 'string' ? Number(raw) : raw
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 「新品」とみなせる状態か。Like New(ほぼ新品)は中古扱いなので除く。
 */
export function isStrictNew(condition: string | undefined | null): boolean {
  const value = (condition ?? '').trim().toLowerCase()
  if (!value) return true
  return (value.includes('new') || value.includes('brand') || value.includes('unused'))
    && !value.includes('like')
}

/**
 * 新品の最安オファーを選ぶ。
 *
 * 実データで確認した注意点(2026-07-19):
 * - Amazonの「招待をリクエストする」オファーは一般客が買えないのに、Amazon発送・
 *   新品として普通にAPIに返る(例: B0F18J2CJF が¥5,412で返るが実際のカートボックスは
 *   ¥13,250)。専用のフラグは無いので、カートボックス未獲得かつカートボックス価格の
 *   半額未満なら除外する。Offers配列とSummary.LowestPricesの両方が汚染されるため、
 *   ここでは Offers だけを見て選ぶ。
 * - 価格は本体価格(ListingPrice)を使う。LandedPriceはポイント控除が入り、
 *   表示金額と食い違う。
 * - Amazon発送の判定は IsFulfilledByAmazon(bool)。このエンドポイントの
 *   FulfillmentChannel は常に null で使えない。
 */
export function pickBestNewOffer(payload: SpApiOffersPayload | null | undefined): PickedOffer | null {
  const offers = payload?.Offers ?? []
  if (offers.length === 0) return null

  // カートボックス価格 = 通常の客が実際に買える価格
  let buyBox: number | null = null
  for (const bb of payload?.Summary?.BuyBoxPrices ?? []) {
    if (bb.condition && !isStrictNew(bb.condition)) continue
    const value = toNumber(bb.ListingPrice)
    if (value !== null && value > 0 && (buyBox === null || value < buyBox)) buyBox = value
  }

  const newOffers = offers.filter((offer) => isStrictNew(offer.SubCondition ?? offer.Condition))
  const prices = newOffers
    .map((offer) => toNumber(offer.ListingPrice))
    .filter((price): price is number => price !== null && price > 0)
    .sort((a, b) => a - b)
  // カートボックスが無い商品は「2番目に安い新品」を基準にする
  // (実測: 正常な商品の最安/2番目は0.66〜1.00、招待限定は0.37)
  const secondCheapest = prices.length > 1 ? prices[1] : null

  const isUnbuyable = (price: number, isBuyBoxWinner: boolean): boolean => {
    if (isBuyBoxWinner) return false
    if (buyBox !== null) return price < buyBox * UNBUYABLE_PRICE_RATIO
    if (secondCheapest !== null) return price < secondCheapest * UNBUYABLE_PRICE_RATIO
    return false
  }

  let best: PickedOffer | null = null
  let excludedUnbuyable = 0
  for (const offer of newOffers) {
    const price = toNumber(offer.ListingPrice)
    if (price === null || price <= 0) continue
    if (isUnbuyable(price, Boolean(offer.IsBuyBoxWinner))) {
      excludedUnbuyable += 1
      continue
    }
    const shipping = toNumber(offer.Shipping) ?? 0
    // 本体価格が安い方。同額なら送料が安い方
    if (!best
      || price < best.listingPriceJpy
      || (price === best.listingPriceJpy && shipping < best.shippingJpy)) {
      best = {
        listingPriceJpy: price,
        shippingJpy: shipping,
        isFba: Boolean(offer.IsFulfilledByAmazon),
        excludedUnbuyable: 0,
        offerCount: newOffers.length,
      }
    }
  }

  if (!best) return null
  return { ...best, excludedUnbuyable }
}
