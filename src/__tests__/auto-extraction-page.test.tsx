// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AutoExtractionPageClient from '@/app/(dashboard)/auto-extraction/AutoExtractionPageClient'

const baseSchedule = {
  id: 'schedule-1',
  name: '月次テスト',
  source_url: 'https://example.com/search',
  seller_account_id: 'seller-1',
  category_id: 'category-1',
  bulk_edit_setting_id: 'bulk-1',
  process_type: 'extract' as const,
  schedule_day_of_month: 8,
  schedule_time: '10:30',
  enabled: true,
  created_at: '2026-08-23T00:00:00.000Z',
  updated_at: '2026-08-23T00:00:00.000Z',
  latest_run: null,
}

describe('AutoExtractionPageClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return { ok: true, json: async () => ({ schedules: [] }) }
      if (init.method === 'POST') return { ok: true, json: async () => ({ schedule: baseSchedule }) }
      if (init.method === 'PATCH') return { ok: true, json: async () => ({ schedule: { ...baseSchedule, enabled: false } }) }
      if (init.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) }
      throw new Error(`Unexpected method: ${init.method}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('registers a schedule and displays it in the list', async () => {
    render(<AutoExtractionPageClient
      sellers={[{ id: 'seller-1', seller_id: 'seller', display_name: '販売アカウント', is_default: true }]}
      categories={[{ id: 'category-1', name: '楽器', ebay_category_id: '619' }]}
      bulkSettings={[{ id: 'bulk-1', name: '標準設定' }]}
    />)
    await screen.findByText('登録済みのスケジュールはありません。')

    await userEvent.type(screen.getByLabelText('スケジュール名（任意）'), '月次テスト')
    await userEvent.type(screen.getByLabelText(/抽出対象URL/), 'https://example.com/search')
    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'category-1')
    await userEvent.selectOptions(screen.getByLabelText('一括編集設定'), 'bulk-1')
    await userEvent.selectOptions(screen.getByLabelText('処理タイプ'), 'extract')
    await userEvent.clear(screen.getByLabelText('実行日（毎月1〜28日）'))
    await userEvent.type(screen.getByLabelText('実行日（毎月1〜28日）'), '8')
    await userEvent.clear(screen.getByLabelText('実行時刻（目安）'))
    await userEvent.type(screen.getByLabelText('実行時刻（目安）'), '10:30')
    await userEvent.click(screen.getByRole('button', { name: 'スケジュールを登録' }))

    expect(await screen.findByText('月次テスト')).toBeInTheDocument()
    expect(screen.getByText('毎月8日 9時台実行（10:30は目安）')).toBeInTheDocument()
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      seller_account_id: 'seller-1',
      category_id: 'category-1',
      bulk_edit_setting_id: 'bulk-1',
    })
  })

  it('toggles and deletes an existing schedule', async () => {
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return { ok: true, json: async () => ({ schedules: [baseSchedule] }) }
      if (init.method === 'PATCH') return { ok: true, json: async () => ({ schedule: { ...baseSchedule, enabled: false } }) }
      return { ok: true, json: async () => ({ ok: true }) }
    })

    render(<AutoExtractionPageClient sellers={[]} categories={[]} bulkSettings={[]} />)
    await screen.findByText('月次テスト')

    await userEvent.click(screen.getByRole('switch', { name: '月次テストを無効にする' }))
    await waitFor(() => expect(screen.getByText('無効')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/auto-extraction-schedules/schedule-1', expect.objectContaining({ method: 'PATCH' }))

    await userEvent.click(screen.getByRole('button', { name: '月次テストを削除' }))
    await waitFor(() => expect(screen.queryByText('月次テスト')).not.toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/auto-extraction-schedules/schedule-1', { method: 'DELETE' })
  })

  it('shows the latest listing-readiness summary and links to the extraction result', async () => {
    const scheduleWithResult = {
      ...baseSchedule,
      process_type: 'extract_and_list' as const,
      latest_run: {
        id: 'run-1',
        extraction_id: 'extraction-1',
        status: 'completed' as const,
        result_summary: { extracted: 3, ready_to_list: 1, needs_fix: 2 },
        error_message: null,
        created_at: '2026-08-24T00:00:00.000Z',
        finished_at: '2026-08-24T00:01:00.000Z',
      },
    }
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ schedules: [scheduleWithResult] }) })

    render(<AutoExtractionPageClient sellers={[]} categories={[]} bulkSettings={[]} />)

    expect(await screen.findByText('抽出 3件')).toBeInTheDocument()
    expect(screen.getByText('出品準備完了 1件')).toBeInTheDocument()
    expect(screen.getByText('要確認 2件')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '抽出結果を確認して出品へ' })).toHaveAttribute(
      'href',
      '/extraction/extraction-1',
    )
  })

  it('does not show listing-readiness counts for extract-only schedules', async () => {
    const extractOnlyResult = {
      ...baseSchedule,
      latest_run: {
        id: 'run-1',
        extraction_id: 'extraction-1',
        status: 'completed' as const,
        result_summary: { extracted: 2 },
        error_message: null,
        created_at: '2026-08-24T00:00:00.000Z',
        finished_at: '2026-08-24T00:01:00.000Z',
      },
    }
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ schedules: [extractOnlyResult] }) })

    render(<AutoExtractionPageClient sellers={[]} categories={[]} bulkSettings={[]} />)

    expect(await screen.findByText('抽出 2件')).toBeInTheDocument()
    expect(screen.queryByText(/出品準備完了/)).not.toBeInTheDocument()
    expect(screen.queryByText(/要確認/)).not.toBeInTheDocument()
  })
})
