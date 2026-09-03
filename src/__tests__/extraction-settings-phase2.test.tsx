// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExtractionSettingsPage from '../app/(dashboard)/extraction-settings/page'

// ユーザー要望: 公式ツールの「除外詳細」と同等の除外機能を抽出時に実装
// してほしい(Phase 2)。評価数・発送日数・最終更新月・価格範囲・
// スポット文字は、これまで閾値を保存する場所がなかったため、抽出設定に
// 保存できるUIを新設した。
describe('抽出設定ページ: Phase 2(スポット文字・閾値設定)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  function mockInitialLoad(overrides: {
    settings?: Record<string, unknown>
    spots?: { id: string; word: string }[]
  } = {}) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        settings: overrides.settings ?? null,
        sellers: [],
        words: [],
        replaces: [],
        templates: [],
        vero: [],
        spots: overrides.spots ?? [],
      }),
    })
  }

  it('抽出危険設定タブにスポット文字セクションが表示され、登録済み文字が見える', async () => {
    mockInitialLoad({ spots: [{ id: 's1', word: '難あり' }] })
    render(<ExtractionSettingsPage />)

    await waitFor(() => screen.getByText('抽出危険設定'))
    await userEvent.click(screen.getByText('抽出危険設定'))

    expect(screen.getByText('スポット文字')).toBeInTheDocument()
    expect(screen.getByText('難あり')).toBeInTheDocument()
  })

  it('スポット文字を入力して追加すると、type: spotでPOSTされる', async () => {
    mockInitialLoad()
    render(<ExtractionSettingsPage />)

    await waitFor(() => screen.getByText('抽出危険設定'))
    await userEvent.click(screen.getByText('抽出危険設定'))

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    mockInitialLoad({ spots: [{ id: 's1', word: 'ジャンク品' }] })

    const spotSection = within(screen.getByText('スポット文字').closest('.mb-8') as HTMLElement)
    await userEvent.type(spotSection.getByPlaceholderText('除外文字'), 'ジャンク品')
    await userEvent.click(spotSection.getByRole('button', { name: '追加' }))

    await waitFor(() => expect(screen.getByText('ジャンク品')).toBeInTheDocument())

    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')
    expect(JSON.parse(postCall![1].body)).toEqual({ type: 'spot', word: 'ジャンク品' })
  })

  it('評価数・発送日数・最終更新月・価格範囲の閾値を入力して保存すると、type: settingsでPOSTされる', async () => {
    mockInitialLoad()
    render(<ExtractionSettingsPage />)

    await waitFor(() => screen.getByText('抽出危険設定'))
    await userEvent.click(screen.getByText('抽出危険設定'))

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })

    const ratingInput = screen.getByText('評価数(この件数未満のセラーを除外)').closest('label')!.querySelector('input')!
    await userEvent.type(ratingInput, '10')

    const shippingInput = screen.getByText('発送日数(この日数を超えたら除外)').closest('label')!.querySelector('input')!
    await userEvent.type(shippingInput, '5')

    await userEvent.click(screen.getAllByRole('button', { name: '設定保存' })[0])

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')
      expect(postCall).toBeTruthy()
    })

    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')
    const body = JSON.parse(postCall![1].body)
    expect(body.type).toBe('settings')
    expect(body.rating_min).toBe(10)
    expect(body.shipping_days_max).toBe(5)
  })
})
