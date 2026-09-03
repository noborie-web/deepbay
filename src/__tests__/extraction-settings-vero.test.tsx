// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExtractionSettingsPage from '../app/(dashboard)/extraction-settings/page'

// ユーザー報告: 抽出危険設定ページに危険セラー・危険単語の登録UIは
// あるが、Veroブランドを登録・確認するUIが存在しなかった。バックエンド
// (/api/extraction-settings)はvero typeを既に完全にサポートしている
// (危険セラー・危険単語と同じ実装)ため、フロントエンドの表示漏れだった。
describe('抽出設定ページ: Veroブランドの登録UI', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  function mockInitialLoad(vero: { id: string; brand: string }[] = []) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        settings: null,
        sellers: [],
        words: [],
        replaces: [],
        templates: [],
        vero,
      }),
    })
  }

  it('抽出危険設定タブにVeroセクションが表示され、登録済みブランドが見える', async () => {
    mockInitialLoad([{ id: 'v1', brand: 'GUCCI' }])
    render(<ExtractionSettingsPage />)

    await waitFor(() => screen.getByText('抽出危険設定'))
    await userEvent.click(screen.getByText('抽出危険設定'))

    expect(screen.getByText('Vero')).toBeInTheDocument()
    expect(screen.getByText('GUCCI')).toBeInTheDocument()
  })

  it('ブランド名を入力して「追加」を押すと、type: veroでPOSTし、一覧が更新される', async () => {
    mockInitialLoad([])
    render(<ExtractionSettingsPage />)

    await waitFor(() => screen.getByText('抽出危険設定'))
    await userEvent.click(screen.getByText('抽出危険設定'))

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    mockInitialLoad([{ id: 'v1', brand: 'LOUIS VUITTON' }])

    const veroSection = within(screen.getByText('Vero').closest('.mb-8') as HTMLElement)
    await userEvent.type(veroSection.getByPlaceholderText('除外ブランド名'), 'LOUIS VUITTON')
    await userEvent.click(veroSection.getByRole('button', { name: '追加' }))

    await waitFor(() => expect(screen.getByText('LOUIS VUITTON')).toBeInTheDocument())

    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')
    expect(JSON.parse(postCall![1].body)).toEqual({ type: 'vero', brand: 'LOUIS VUITTON' })
  })

  it('削除ボタンでtype: veroのDELETEリクエストを送り、一覧から消える', async () => {
    mockInitialLoad([{ id: 'v1', brand: 'GUCCI' }])
    render(<ExtractionSettingsPage />)

    await waitFor(() => screen.getByText('抽出危険設定'))
    await userEvent.click(screen.getByText('抽出危険設定'))
    await waitFor(() => screen.getByText('GUCCI'))

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    const veroSection = within(screen.getByText('Vero').closest('.mb-8') as HTMLElement)
    await userEvent.click(veroSection.getByRole('button', { name: '削除' }))

    await waitFor(() => expect(screen.queryByText('GUCCI')).not.toBeInTheDocument())
    const deleteCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'DELETE')
    expect(JSON.parse(deleteCall![1].body)).toEqual({ type: 'vero', id: 'v1' })
  })
})
