import clsx from 'clsx'
import type { SellerAccount } from '@/types/database'

// ユーザー要望(2026-09-26): 出品アカウントを2つ使い分ける(miyabi-24=US /
// akebono-32=UK・AU)ため、一覧でどのセラー・どのサイト向けかを一目で
// 見分けられるようにする。サイトの組み合わせで色を変える。
export function sellerSites(seller: Pick<SellerAccount, 'listing_site_ids'>): string[] {
  const sites = (seller.listing_site_ids ?? ['US'])
    .map(site => site.toUpperCase())
    .filter(site => site === 'US' || site === 'UK' || site === 'AU')
  return sites.length > 0 ? sites : ['US']
}

function toneFor(sites: string[]): string {
  if (sites.length === 1 && sites[0] === 'US') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (!sites.includes('US')) return 'bg-purple-50 text-purple-700 border-purple-200'
  return 'bg-amber-50 text-amber-700 border-amber-200'
}

interface Props {
  seller: Pick<SellerAccount, 'seller_id' | 'display_name' | 'listing_site_ids'>
  className?: string
}

export default function SellerBadge({ seller, className }: Props) {
  const sites = sellerSites(seller)
  const label = seller.display_name?.trim() || seller.seller_id
  return (
    <span
      className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium', toneFor(sites), className)}
      title={`出品セラー: ${seller.seller_id} / 出品サイト: ${sites.join('・')}`}
    >
      {label}
      <span className="rounded bg-white/70 px-1 text-[10px] tracking-wide">{sites.join('/')}</span>
    </span>
  )
}
