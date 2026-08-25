// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BulkEditSettingModal from '@/components/extraction/BulkEditSettingModal'
import type { BulkEditSetting } from '@/types/database'

const existingSetting: BulkEditSetting = {
  id: 'bulk-1',
  user_id: 'user-1',
  name: '既存設定',
  price_rate: 1,
  title_prefix: '',
  title_suffix: '',
  description_template: '',
  condition_mapping: {},
  profit_rate: 0.25,
  ebay_fee_rate: 0.18,
  shipping_cost_jpy: 2500,
  fixed_cost_usd: 1,
  created_at: '2026-08-25T00:00:00.000Z',
  updated_at: '2026-08-25T00:00:00.000Z',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('BulkEditSettingModal', () => {
  it('creates a setting with automatic pricing fields', async () => {
    const onSaved = vi.fn()
    const onClose = vi.fn()
    const saved = { ...existingSetting, id: 'bulk-new', name: '自動価格設定' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input
      void init
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={null} onSaved={onSaved} onClose={onClose} />)

    await userEvent.type(screen.getByLabelText(/設定名/), '自動価格設定')
    await userEvent.type(screen.getByLabelText('目標利益率'), '0.25')
    await userEvent.type(screen.getByLabelText('eBay手数料率'), '0.18')
    await userEvent.type(screen.getByLabelText('送料（円）'), '2500')
    await userEvent.type(screen.getByLabelText('固定費（USD）'), '1')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/bulk-edit-settings', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      name: '自動価格設定',
      profit_rate: 0.25,
      ebay_fee_rate: 0.18,
      shipping_cost_jpy: 2500,
      fixed_cost_usd: 1,
    })
    expect(onSaved).toHaveBeenCalledWith(saved)
    expect(onClose).toHaveBeenCalled()
  })

  it('loads and updates an existing setting', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input
      void init
      return { ok: true, json: async () => ({ setting: existingSetting }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByLabelText('目標利益率')).toHaveValue(0.25)
    expect(screen.getByLabelText('送料（円）')).toHaveValue(2500)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(fetchMock).toHaveBeenCalledWith('/api/bulk-edit-settings', expect.objectContaining({ method: 'PATCH' }))
    expect(body.id).toBe('bulk-1')
  })
})
