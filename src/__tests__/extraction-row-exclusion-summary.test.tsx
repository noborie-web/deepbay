// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import ExtractionRow from '@/components/extraction/ExtractionRow'
import type { Extraction } from '@/types/database'

function makeExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    id: 'ext-1',
    user_id: 'user-1',
    source_url: 'https://jp.mercari.com/search?keyword=guitar',
    source_site: 'mercari',
    seller_account_id: null,
    category_id: null,
    bulk_edit_setting_id: null,
    status: 'completed',
    progress: 100,
    memo: '',
    is_bulk: true,
    extracted_at: '2026-08-30T00:00:00.000Z',
    error_message: null,
    exclusion_summary: null,
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    ...overrides,
  }
}

// ユーザー要望: 既存ツール(公式)の「除外詳細」に相当する内訳表示。
describe('ExtractionRow: 除外詳細', () => {
  it('exclusion_summaryがある場合、メニューから開いて内訳を表示できる', async () => {
    const extraction = makeExtraction({
      exclusion_summary: {
        detail_fetch_count: 357,
        sold_out_excluded: 0,
        no_image_excluded: 0,
        no_price_excluded: 0,
        danger_word_excluded: 0,
        vero_excluded: 0,
        individual_danger_seller_excluded: 0,
        spot_word_excluded: 0,
        low_rating_excluded: 0,
        slow_shipping_excluded: 0,
        stale_excluded: 0,
        price_range_excluded: 0,
        active_duplicate_excluded: 0,
        title_duplicate_excluded: 12,
        translated_duplicate_excluded: 0,
        completed_count: 345,
      },
    })

    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
    await userEvent.click(screen.getByRole('button', { name: '除外詳細' }))

    expect(screen.getByText('タイトル重複除外')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('詳細取得件数')).toBeInTheDocument()
    expect(screen.getByText('357')).toBeInTheDocument()
    expect(screen.getByText('取得完了件数')).toBeInTheDocument()
    expect(screen.getByText('345')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'とじる' }))
    expect(screen.queryByText('タイトル重複除外')).not.toBeInTheDocument()
  })

  it('exclusion_summaryがない場合、メニュー項目は無効化される', async () => {
    const extraction = makeExtraction({ exclusion_summary: null })
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
    expect(screen.getByRole('button', { name: '除外詳細' })).toBeDisabled()
  })
})
