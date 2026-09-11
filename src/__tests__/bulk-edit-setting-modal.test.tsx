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
  memo: '',
  is_default: false,
  is_enabled: true,
  vero_exclude_enabled: true,
  danger_seller_exclude_enabled: true,
  danger_word_exclude_enabled: true,
  price_range_enabled: false,
  price_min: null,
  price_max: null,
  rating_exclude_enabled: false,
  rating_min: null,
  shipping_days_exclude_enabled: false,
  shipping_days_max: null,
  updated_months_exclude_enabled: false,
  updated_months_ago: null,
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

  // ユーザー要望: 公式ツールのように、一括編集設定ごとに除外条件を
  // 個別に有効/無効切り替えできるようにしたい。
  it('除外設定タブでVero除外を無効にでき、保存時にその状態が送信される', async () => {
    const saved = { ...existingSetting }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input
      void init
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '除外設定' }))
    // Veroワード除外の有効/無効トグルは除外設定タブの先頭に表示される
    await userEvent.click(screen.getAllByRole('button', { name: '有効' })[0])
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.vero_exclude_enabled).toBe(false)
  })

  it('ヘッダーの「この設定」トグルで一括編集設定全体を無効にでき、保存時に送信される', async () => {
    const saved = { ...existingSetting }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input
      void init
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'この設定有効' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'この設定有効' }))
    expect(screen.getByRole('button', { name: 'この設定無効' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.is_enabled).toBe(false)
  })

  it('コピー(id無し)で渡された場合はPOSTで新規作成される', async () => {
    const copySource = { ...existingSetting, id: '', name: '既存設定 のコピー' }
    const saved = { ...copySource, id: 'bulk-2' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input
      void init
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={copySource} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/bulk-edit-settings', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.id).toBeFalsy()
    expect(body.name).toBe('既存設定 のコピー')
  })
})
