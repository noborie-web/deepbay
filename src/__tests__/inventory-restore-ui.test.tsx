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
    await userEvent.type(screen.getByPlaceholderText(/DBK-IDを入力してください/), dbkId)
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

  it('該当商品が見つからない場合は、従来通りその旨のメッセージのみ表示する', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ found: false, source_url: null }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<InventoryPanel listings={[]} listingCount={0} hasToken={false} />)

    await userEvent.type(screen.getByPlaceholderText(/DBK-IDを入力してください/), 'deepbay_unknown')
    await userEvent.click(screen.getByRole('button', { name: '復元' }))

    expect(await screen.findByText('該当する商品が見つかりませんでした。')).toBeInTheDocument()
    expect(screen.queryByText('復元結果')).not.toBeInTheDocument()
  })
})
