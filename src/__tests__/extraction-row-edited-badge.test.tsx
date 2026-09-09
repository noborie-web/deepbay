// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
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
    edited_at: null,
    is_bulk: true,
    extracted_at: '2026-08-30T00:00:00.000Z',
    error_message: null,
    exclusion_summary: null,
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    ...overrides,
  }
}

// ユーザー要望: 既存ツール(公式)の抽出一覧と同様、商品編集画面で保存
// した抽出には「編集済み」バッジを表示したい。
describe('ExtractionRow: 編集済みバッジ', () => {
  it('edited_atが設定されていれば「編集済み」バッジを表示する', () => {
    const extraction = makeExtraction({ edited_at: '2026-09-09T00:00:00.000Z' })
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    expect(screen.getByText('編集済み')).toBeInTheDocument()
  })

  it('edited_atがnullなら「編集済み」バッジを表示しない', () => {
    const extraction = makeExtraction({ edited_at: null })
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    expect(screen.queryByText('編集済み')).not.toBeInTheDocument()
  })
})
