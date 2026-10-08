// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryPanel from '@/components/inventory/InventoryPanel'

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({}),
}))

// ユーザー要望: 既存ツール(公式)の暗号化復元結果表示(「復元結果」見出し +
// DBK-ID/商品名/商品urlのラベル付き表示)に合わせる。
describe('InventoryPanel: 暗号化復元の結果表示', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('復元に成功すると、DBK-ID・商品名・商品urlをラベル付きで表示する', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        found: true,
        source_url: 'https://jp.mercari.com/item/m78023298495',
        title: 'コードギアス ルルーシュ アクリルスタンド アクスタ ミスティックフェザー',
        product_id: 'product-1',
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)

    const dbkId = 'deepbay_21522c98_fe39_46b7_aa89_f0b71be24718'
    await userEvent.type(screen.getByPlaceholderText(/DBK-ID/), dbkId)
    await userEvent.click(screen.getByRole('button', { name: '復元' }))

    expect(await screen.findByText('復元結果')).toBeInTheDocument()
    expect(screen.getByText('DBK-ID:')).toBeInTheDocument()
    expect(screen.getByText(dbkId)).toBeInTheDocument()
    expect(screen.getByText('商品名:')).toBeInTheDocument()
    expect(screen.getByText(/コードギアス/)).toBeInTheDocument()
    expect(screen.getByText('商品url:')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'https://jp.mercari.com/item/m78023298495' })
    expect(link).toHaveAttribute('href', 'https://jp.mercari.com/item/m78023298495')
  })

  it('形式が認識できない場合は、入力できる値を案内する', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ found: false, source_url: null }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)

    await userEvent.type(screen.getByPlaceholderText(/DBK-ID/), 'deepbay_unknown')
    await userEvent.click(screen.getByRole('button', { name: '復元' }))

    expect(await screen.findByText('該当する商品が見つかりませんでした。')).toBeInTheDocument()
    expect(screen.queryByText('復元結果')).not.toBeInTheDocument()
  })

  // ユーザー報告(2026-10-08): 売れた商品のDBK-IDで「見つかりませんでした」と
  // 出たが、IDの形式が違うのか商品が消えているのかが区別できなかった。
  it('IDは読み取れたが商品が無い場合は、削除済みの可能性を案内する', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ found: false, source_url: null, reason: 'product_missing' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)

    await userEvent.type(screen.getByPlaceholderText(/DBK-ID/), 'kakehashi_9ef13534_4516_4002_ae6e_defdf80b4d54')
    await userEvent.click(screen.getByRole('button', { name: '復元' }))

    expect(await screen.findByText('DBK-IDは読み取れましたが、該当する商品がKakehashiにありません。')).toBeInTheDocument()
  })

  it('売却済みの出品は、出品の状態とeBay商品番号も表示する', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        found: true,
        source_url: 'https://jp.mercari.com/item/m999',
        title: '売れた商品',
        ended_reason: 'sold',
        ebay_item_id: '377535920770',
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)

    await userEvent.type(screen.getByPlaceholderText(/DBK-ID/), '377535920770')
    await userEvent.click(screen.getByRole('button', { name: '復元' }))

    expect(await screen.findByText(/売却済み（eBay商品番号: 377535920770）/)).toBeInTheDocument()
  })
})
