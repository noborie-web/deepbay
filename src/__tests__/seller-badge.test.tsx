// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'
import SellerBadge, { sellerSites } from '@/components/extraction/SellerBadge'

// ユーザー要望(2026-09-26): 一括抽出/出品の一覧で miyabi-24(US) と
// akebono-32(UK/AU) を見分けやすくする。
const miyabi = { seller_id: 'miyabi-24', display_name: 'miyabi-24', listing_site_ids: ['US'] }
const akebono = { seller_id: 'akebono-32', display_name: null, listing_site_ids: ['UK', 'AU'] }

describe('出品セラーのバッジ', () => {
  it('セラー名と出品サイトを並べて表示する', () => {
    render(<SellerBadge seller={akebono} />)
    expect(screen.getByText('akebono-32')).toBeInTheDocument()
    expect(screen.getByText('UK/AU')).toBeInTheDocument()
    expect(screen.getByTitle('出品セラー: akebono-32 / 出品サイト: UK・AU')).toBeInTheDocument()
  })

  it('US専用とUK/AUで色を分ける', () => {
    const { container: us } = render(<SellerBadge seller={miyabi} />)
    const { container: nonUs } = render(<SellerBadge seller={akebono} />)
    expect(us.firstElementChild?.className).toContain('blue')
    expect(nonUs.firstElementChild?.className).toContain('purple')
  })

  it('出品サイト未設定はUSとして扱う', () => {
    expect(sellerSites({ listing_site_ids: null })).toEqual(['US'])
    expect(sellerSites({ listing_site_ids: [] })).toEqual(['US'])
    expect(sellerSites({ listing_site_ids: ['uk', 'DE'] })).toEqual(['UK'])
  })
})
