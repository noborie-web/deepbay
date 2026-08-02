// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import ExclusionDetailsModal from '@/components/extraction/ExclusionDetailsModal'
import type { Extraction } from '@/types/database'

const extraction: Extraction = {
  id: 'ext-1',
  user_id: 'user-1',
  source_url: 'https://jp.mercari.com/search?keyword=pen',
  source_site: 'mercari',
  seller_account_id: null,
  category_id: null,
  bulk_edit_setting_id: null,
  status: 'completed',
  progress: 100,
  memo: '',
  is_bulk: true,
  extracted_at: '2026-07-26T01:00:00.000Z',
  error_message: null,
  created_at: '2026-07-26T00:00:00.000Z',
  updated_at: '2026-07-26T00:00:00.000Z',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ExclusionDetailsModal', () => {
  it('除外商品・理由・元価格を表示し、理由で絞り込める', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        activities: [],
        excludedProducts: [
          {
            id: 'excluded-1',
            extraction_id: 'ext-1',
            user_id: 'user-1',
            product_id: 'product-1',
            reason_code: 'sold_out',
            reason_label: '売り切れ',
            source_url: 'https://jp.mercari.com/item/m1',
            original_title: '万年筆 ブラック',
            original_price: 5000,
            image_url: null,
            metadata: {},
            excluded_at: '2026-07-26T02:00:00.000Z',
          },
          {
            id: 'excluded-2',
            extraction_id: 'ext-1',
            user_id: 'user-1',
            product_id: 'product-2',
            reason_code: 'danger_seller',
            reason_label: '危険セラー',
            source_url: 'https://jp.mercari.com/item/m2',
            original_title: 'ボールペン ブルー',
            original_price: 1200,
            image_url: null,
            metadata: {},
            excluded_at: '2026-07-26T03:00:00.000Z',
          },
        ],
      }),
    })))

    render(<ExclusionDetailsModal extraction={extraction} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('2件')).toBeInTheDocument())
    expect(screen.getByText('万年筆 ブラック')).toBeInTheDocument()
    expect(screen.getByText('¥5,000')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '万年筆 ブラックを開く' }))
      .toHaveAttribute('href', 'https://jp.mercari.com/item/m1')

    await userEvent.selectOptions(screen.getByRole('combobox'), 'danger_seller')
    expect(screen.queryByText('万年筆 ブラック')).not.toBeInTheDocument()
    expect(screen.getByText('ボールペン ブルー')).toBeInTheDocument()
  })

  it('機能追加前の除外は復元できない旨を空状態で案内する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ activities: [], excludedProducts: [] }),
    })))

    render(<ExclusionDetailsModal extraction={extraction} onClose={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('保存された除外商品はありません。')).toBeInTheDocument())
    expect(screen.getByText(/この機能の追加前に除外・削除された商品/)).toBeInTheDocument()
  })
})
