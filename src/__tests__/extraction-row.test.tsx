// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import ExtractionRow from '@/components/extraction/ExtractionRow'
import type { Extraction, ExtractionActivity } from '@/types/database'

function activity(
  type: ExtractionActivity['activity_type'],
  date: string,
  count: number,
): ExtractionActivity {
  return {
    id: `${type}-${date}`,
    extraction_id: 'extraction-123456',
    user_id: 'user-1',
    activity_type: type,
    label: type,
    item_count: count,
    metadata: {},
    created_at: date,
  }
}

const extraction: Extraction = {
  id: 'extraction-123456',
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
  extracted_at: '2026-07-24T00:00:00.000Z',
  error_message: null,
  created_at: '2026-07-24T00:00:00.000Z',
  updated_at: '2026-07-24T00:00:00.000Z',
  activities: [
    activity('edited', '2026-07-25T00:00:00.000Z', 10),
    activity('csv_exported', '2026-07-26T00:00:00.000Z', 10),
    activity('excluded', '2026-07-26T01:00:00.000Z', 3),
  ],
}

describe('ExtractionRow', () => {
  it('編集・CSV出力・除外の状態を一覧に表示する', () => {
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    expect(screen.getByText('編集済み')).toBeInTheDocument()
    expect(screen.getByText('CSV出力済み')).toBeInTheDocument()
    expect(screen.getByText('除外済み 3件')).toBeInTheDocument()
    expect(screen.getByText(/編集:/).parentElement).toHaveTextContent('2026/7/25')
    expect(screen.getByText(/出力\/出品:/).parentElement).toHaveTextContent('2026/7/26')
  })

  it('メニューから除外詳細を開ける', async () => {
    const onViewExclusions = vi.fn()
    render(
      <ExtractionRow
        extraction={extraction}
        onViewResult={vi.fn()}
        onViewExclusions={onViewExclusions}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
    await userEvent.click(screen.getByRole('button', { name: '除外詳細' }))

    expect(onViewExclusions).toHaveBeenCalledWith('extraction-123456')
  })
})
