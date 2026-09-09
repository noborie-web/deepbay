// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

// ユーザー要望: 既存ツール(公式)の抽出一覧と同様、メモ欄を鉛筆アイコンから
// 直接編集・保存できるようにする(これまで鉛筆ボタンにonClickが無く、
// 見た目だけで機能していなかった)。
describe('ExtractionRow: メモの編集', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('鉛筆アイコンをクリックすると入力欄が表示され、Enterで保存される(PATCH)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, memo: '希少' }) })
    const extraction = makeExtraction({ memo: '' })
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'メモを編集' }))
    const input = screen.getByRole('textbox')
    await userEvent.type(input, '希少')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(screen.getByText('希少')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/extractions/ext-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memo: '希少' }),
    })
  })

  it('既存のメモをクリックして編集し、フォーカスを外すと保存される', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, memo: '更新後' }) })
    const extraction = makeExtraction({ memo: '既存メモ' })
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    expect(screen.getByText('既存メモ')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'メモを編集' }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '更新後')
    await userEvent.tab()

    await waitFor(() => expect(screen.getByText('更新後')).toBeInTheDocument())
  })

  it('Escapeキーで編集をキャンセルすると保存されない', async () => {
    const extraction = makeExtraction({ memo: '元のメモ' })
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'メモを編集' }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '変更中')
    await userEvent.keyboard('{Escape}')

    expect(screen.getByText('元のメモ')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('保存に失敗したら元のメモに戻す', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    const originalAlert = window.alert
    window.alert = vi.fn()
    const extraction = makeExtraction({ memo: '元のメモ' })
    render(<ExtractionRow extraction={extraction} onViewResult={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'メモを編集' }))
    const input = screen.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, '失敗するメモ')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(screen.getByText('元のメモ')).toBeInTheDocument())
    expect(window.alert).toHaveBeenCalled()
    window.alert = originalAlert
  })
})
