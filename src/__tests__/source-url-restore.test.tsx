// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SourceUrlRestore from '@/components/inventory/SourceUrlRestore'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('仕入れ先URL復元', () => {
  it('DBK-IDから本人の商品URLを表示する', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          dbkId: 'ele_20260727_A2B3C4D5E6F7G8H9',
          sourceUrl: 'https://jp.mercari.com/item/m123',
          sourceSite: 'mercari',
          title: 'テスト商品',
          productId: 'product-1',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      }),
    } as Response)

    render(<SourceUrlRestore />)
    fireEvent.change(screen.getByLabelText('DBK-ID'), {
      target: { value: 'ele_20260727_A2B3C4D5E6F7G8H9' },
    })
    fireEvent.click(screen.getByRole('button', { name: '復元' }))

    const link = await screen.findByRole('link', { name: /仕入れ先を開く/ })
    expect(link).toHaveAttribute('href', 'https://jp.mercari.com/item/m123')
    expect(screen.getByText('テスト商品')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inventory/restore-source',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ dbkId: 'ele_20260727_A2B3C4D5E6F7G8H9' }),
      }),
    )
  })

  it('存在しないDBK-IDはエラーを表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: '該当する仕入れ先URLがありません' }),
    } as Response)

    render(<SourceUrlRestore />)
    fireEvent.change(screen.getByLabelText('DBK-ID'), {
      target: { value: 'ele_20260727_Z9Y8X7W6V5U4T3S2' },
    })
    fireEvent.click(screen.getByRole('button', { name: '復元' }))

    await waitFor(() => {
      expect(screen.getByText('該当する仕入れ先URLがありません')).toBeInTheDocument()
    })
  })
})
