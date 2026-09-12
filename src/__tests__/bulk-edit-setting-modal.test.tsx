// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BulkEditSettingModal from '@/components/extraction/BulkEditSettingModal'
import type { BulkEditSetting } from '@/types/database'

// 危険セラーリスト取得(useEffectでマウント時に発火する)と保存呼び出しの
// 両方がfetchを呼ぶため、保存呼び出し(/api/bulk-edit-settingsへのPOST/PATCH)
// だけを呼び出し順に依存せず取り出す。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveCallBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls.find((args: unknown[]) =>
    String(args[0]).includes('/api/bulk-edit-settings') && !String(args[0]).includes('danger-sellers'),
  )
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))
}

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
  sold_out_exclude_enabled: true,
  auto_pricing_enabled: true,
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
  low_rating_exclude_enabled: false,
  low_rating_max: null,
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
      void init
      if (String(input).includes('bulk-edit-danger-sellers')) {
        return { ok: true, json: async () => ({ sellers: [] }) }
      }
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
    const body = saveCallBody(fetchMock)
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

    const body = saveCallBody(fetchMock)
    expect(fetchMock).toHaveBeenCalledWith('/api/bulk-edit-settings', expect.objectContaining({ method: 'PATCH' }))
    expect(body.id).toBe('bulk-1')
  })

  // ユーザー要望: 公式ツールのように、一括編集設定ごとに除外条件を
  // 個別に有効/無効切り替えできるようにしたい。
  it('除外設定タブでVero除外を無効にでき、保存時にその状態が送信される', async () => {
    const saved = { ...existingSetting }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      if (String(input).includes('bulk-edit-danger-sellers')) {
        return { ok: true, json: async () => ({ sellers: [] }) }
      }
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '除外設定' }))
    const veroLabel = screen.getByText('Veroワード除外')
    await userEvent.click(veroLabel.parentElement!.querySelector('button')!)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = saveCallBody(fetchMock)
    expect(body.vero_exclude_enabled).toBe(false)
  })

  it('除外設定タブで売り切れ除外を無効にでき、保存時にその状態が送信される', async () => {
    const saved = { ...existingSetting }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      if (String(input).includes('bulk-edit-danger-sellers')) {
        return { ok: true, json: async () => ({ sellers: [] }) }
      }
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '除外設定' }))
    const soldOutLabel = screen.getByText('売り切れ除外')
    await userEvent.click(soldOutLabel.parentElement!.querySelector('button')!)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = saveCallBody(fetchMock)
    expect(body.sold_out_exclude_enabled).toBe(false)
  })

  it('ヘッダーの「この設定」トグルで一括編集設定全体を無効にでき、保存時に送信される', async () => {
    const saved = { ...existingSetting }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      if (String(input).includes('bulk-edit-danger-sellers')) {
        return { ok: true, json: async () => ({ sellers: [] }) }
      }
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'この設定有効' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'この設定有効' }))
    expect(screen.getByRole('button', { name: 'この設定無効' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = saveCallBody(fetchMock)
    expect(body.is_enabled).toBe(false)
  })

  it('「抽出時の価格自動計算」を個別に無効にでき、保存時にauto_pricing_enabledが送信される(他の項目には影響しない)', async () => {
    const saved = { ...existingSetting }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      if (String(input).includes('bulk-edit-danger-sellers')) {
        return { ok: true, json: async () => ({ sellers: [] }) }
      }
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    // 価格自動計算ボックス内の「有効」ボタン(ヘッダーの全体トグルとは別)
    await userEvent.click(screen.getByRole('button', { name: '有効' }))
    expect(screen.queryByLabelText('目標利益率')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = saveCallBody(fetchMock)
    expect(body.auto_pricing_enabled).toBe(false)
    expect(body.is_enabled).toBe(true)
  })

  it('除外設定タブで低評価数除外を有効にでき、閾値とともに保存される', async () => {
    const saved = { ...existingSetting }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      if (String(input).includes('bulk-edit-danger-sellers')) {
        return { ok: true, json: async () => ({ sellers: [] }) }
      }
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '除外設定' }))
    const lowRatingLabel = screen.getByText('低評価数除外')
    const toggleButton = lowRatingLabel.parentElement!.querySelector('button')!
    await userEvent.click(toggleButton)
    await userEvent.type(screen.getByLabelText(/許容低評価数/), '1')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    const body = saveCallBody(fetchMock)
    expect(body.low_rating_exclude_enabled).toBe(true)
    expect(body.low_rating_max).toBe(1)
  })

  // ユーザー要望: 危険Seller除外の段階②を実際に機能させるため、
  // 一括編集設定プロファイルごとに専用の危険セラーリストを管理できる
  // ようにしたい。
  it('危険セラー除外を開くと専用リストを取得し、追加・削除ができる', async () => {
    let sellers = [{ id: 's1', seller_url: 'https://jp.mercari.com/user/profile/999' }]
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('bulk-edit-danger-sellers')) {
        if (init?.method === 'POST') {
          const added = { id: 's2', seller_url: 'https://jp.mercari.com/user/profile/111' }
          sellers = [...sellers, added]
          return { ok: true, json: async () => ({ seller: added }) }
        }
        if (init?.method === 'DELETE') {
          sellers = sellers.filter((s) => !url.includes(s.id))
          return { ok: true, json: async () => ({ ok: true }) }
        }
        return { ok: true, json: async () => ({ sellers }) }
      }
      return { ok: true, json: async () => ({ setting: existingSetting }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={existingSetting} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '除外設定' }))
    expect(await screen.findByText('https://jp.mercari.com/user/profile/999')).toBeInTheDocument()

    await userEvent.type(screen.getByPlaceholderText('除外セラーURL'), 'https://jp.mercari.com/user/profile/111')
    await userEvent.click(screen.getByRole('button', { name: '追加' }))
    expect(await screen.findByText('https://jp.mercari.com/user/profile/111')).toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0])
    await waitFor(() => expect(screen.queryByText('https://jp.mercari.com/user/profile/999')).not.toBeInTheDocument())
  })

  it('未保存(id無し)の設定では専用リストの代わりに保存を促す案内を表示する', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ setting: existingSetting }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={null} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '除外設定' }))
    expect(screen.getByText('この設定を保存すると、専用の危険セラーリストを登録できます。')).toBeInTheDocument()
  })

  it('コピー(id無し)で渡された場合はPOSTで新規作成される', async () => {
    const copySource = { ...existingSetting, id: '', name: '既存設定 のコピー' }
    const saved = { ...copySource, id: 'bulk-2' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      if (String(input).includes('bulk-edit-danger-sellers')) {
        return { ok: true, json: async () => ({ sellers: [] }) }
      }
      return { ok: true, json: async () => ({ setting: saved }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkEditSettingModal setting={copySource} onSaved={vi.fn()} onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(fetchMock).toHaveBeenCalledWith('/api/bulk-edit-settings', expect.objectContaining({ method: 'POST' }))
    const body = saveCallBody(fetchMock)
    expect(body.id).toBeFalsy()
    expect(body.name).toBe('既存設定 のコピー')
  })
})
