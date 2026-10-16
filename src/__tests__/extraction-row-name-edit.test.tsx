// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExtractionRow from '@/components/extraction/ExtractionRow'
import type { Extraction } from '@/types/database'

// ユーザー要望(2026-10-15): 抽出リスト名を自動で入れたい。
// 画面には以前から「抽出リスト名:」と鉛筆アイコンが出ていたが、保存先の列が
// 無く、押しても何も起きない飾りだった。隣の「メモ」はユーザーが手で書く欄で別物。

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    id: 'extraction-1',
    user_id: 'user-1',
    source_url: 'https://auctions.yahoo.co.jp/category/list/2084064354',
    source_site: 'yahoo_auction',
    status: 'completed',
    progress: 100,
    is_bulk: true,
    name: null,
    memo: '',
    created_at: '2026-10-16T00:00:00.000Z',
    extracted_at: '2026-10-16T00:05:00.000Z',
    error_message: null,
    ...overrides,
  } as Extraction
}

const noop = () => {}

describe('抽出リスト名', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }))
  })

  it('名前が入っていれば表示する', () => {
    render(<ExtractionRow extraction={extraction({ name: 'アブガルシア' })} onViewResult={noop} />)
    expect(screen.getByText('アブガルシア')).toBeTruthy()
  })

  it('鉛筆から編集して保存できる（以前は押しても何も起きなかった）', async () => {
    render(<ExtractionRow extraction={extraction()} onViewResult={noop} />)
    fireEvent.click(screen.getByLabelText('抽出リスト名を編集'))
    const input = screen.getByDisplayValue('')
    fireEvent.change(input, { target: { value: 'リール' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/extractions/extraction-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ name: 'リール' }),
      }))
    })
    expect(screen.getByText('リール')).toBeTruthy()
  })

  // メモは手で書く欄。名前の編集で消したり上書きしたりしない
  it('メモとは別の欄として扱う', async () => {
    render(<ExtractionRow extraction={extraction({ name: 'リール', memo: '手書きメモ' })} onViewResult={noop} />)
    expect(screen.getByText('リール')).toBeTruthy()
    expect(screen.getByText('手書きメモ')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('抽出リスト名を編集'))
    fireEvent.change(screen.getByDisplayValue('リール'), { target: { value: 'ロッド' } })
    fireEvent.keyDown(screen.getByDisplayValue('ロッド'), { key: 'Enter' })

    await waitFor(() => {
      // 送るのは name だけ(memo は触らない)
      expect(JSON.parse((fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0][1].body))
        .toEqual({ name: 'ロッド' })
    })
    expect(screen.getByText('手書きメモ')).toBeTruthy()
  })

  it('保存に失敗したら元の名前に戻す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    vi.stubGlobal('alert', vi.fn())
    render(<ExtractionRow extraction={extraction({ name: 'リール' })} onViewResult={noop} />)
    fireEvent.click(screen.getByLabelText('抽出リスト名を編集'))
    fireEvent.change(screen.getByDisplayValue('リール'), { target: { value: 'ロッド' } })
    fireEvent.keyDown(screen.getByDisplayValue('ロッド'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('リール')).toBeTruthy())
  })
})
