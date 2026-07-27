// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExtractionResultModal from '@/components/extraction/ExtractionResultModal'
import type { Extraction } from '@/types/database'

const extraction: Extraction = {
  id: 'ext-result-1',
  user_id: 'user-1',
  source_url: 'https://jp.mercari.com/search?keyword=test',
  source_site: 'mercari',
  seller_account_id: null,
  category_id: null,
  bulk_edit_setting_id: null,
  status: 'completed',
  progress: 100,
  memo: '',
  is_bulk: true,
  extracted_at: '2026-07-27T09:00:00.000Z',
  error_message: null,
  created_at: '2026-07-27T09:00:00.000Z',
  updated_at: '2026-07-27T09:00:00.000Z',
}

describe('ExtractionResultModal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        activities: [],
        currentProductCount: 120,
        excludedProducts: [
          {
            id: 'excluded-1',
            extraction_id: extraction.id,
            user_id: 'user-1',
            product_id: 'product-1',
            reason_code: 'shipping_days',
            reason_label: '発送日数',
            source_url: 'https://example.com/1',
            original_title: '商品1',
            original_price: 1000,
            image_url: null,
            metadata: {},
            excluded_at: '2026-07-27T09:05:00.000Z',
          },
        ],
      }),
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('抽出結果の集計をウィンドウ内に表示する', async () => {
    render(
      <ExtractionResultModal
        extraction={extraction}
        onClose={vi.fn()}
        onOpenProducts={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('抽出結果確認')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('初回取得件数')).toBeInTheDocument())
    expect(screen.getByText('（一括編集）発送日数除外')).toBeInTheDocument()
    expect(screen.getByText('取得完了件数')).toBeInTheDocument()
  })

  it('商品一覧ボタンと閉じるボタンを呼び分ける', async () => {
    const onClose = vi.fn()
    const onOpenProducts = vi.fn()
    render(
      <ExtractionResultModal
        extraction={extraction}
        onClose={onClose}
        onOpenProducts={onOpenProducts}
      />,
    )
    await waitFor(() => expect(screen.getByText('初回取得件数')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /商品一覧を開く/ }))
    expect(onOpenProducts).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
