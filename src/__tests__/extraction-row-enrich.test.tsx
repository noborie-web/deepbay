// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'
import ExtractionRow from '@/components/extraction/ExtractionRow'
import type { Extraction } from '@/types/database'

// ユーザー要望(2026-10-15): 商品ページからの補完が残っているかを、抽出結果を
// 開かなくても抽出一覧で分かるようにしたい。

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    id: 'extraction-1',
    user_id: 'user-1',
    source_url: 'https://auctions.yahoo.co.jp/category/list/2084064354',
    source_site: 'yahoo_auction',
    status: 'completed',
    progress: 100,
    is_bulk: true,
    memo: '',
    created_at: '2026-10-15T00:00:00.000Z',
    extracted_at: '2026-10-15T00:05:00.000Z',
    error_message: null,
    ...overrides,
  } as Extraction
}

const noop = () => {}

describe('抽出一覧の補完状況', () => {
  it('補完待ちの件数と進み具合を出す', () => {
    render(<ExtractionRow
      extraction={extraction()}
      enrichPending={{ pending: 185, total: 317 }}
      onViewResult={noop}
    />)
    expect(screen.getByText(/補完待ち 185件/)).toBeTruthy()
    // 317件中132件が補完済み
    expect(screen.getByText(/132\/317/)).toBeTruthy()
  })

  it('補完が終わっていれば「補完済み」と出す', () => {
    render(<ExtractionRow
      extraction={extraction()}
      enrichPending={{ pending: 0, total: 109 }}
      onViewResult={noop}
    />)
    expect(screen.getByText(/補完済み 109件/)).toBeTruthy()
    expect(screen.queryByText(/補完待ち/)).toBeNull()
  })

  // 集計に失敗した抽出は undefined で渡る。「0件」と見せて誤解させない
  it('件数が分からないときは何も出さない', () => {
    render(<ExtractionRow extraction={extraction()} onViewResult={noop} />)
    expect(screen.queryByText(/補完/)).toBeNull()
  })

  it('補完対象の商品が無い抽出(Amazon等)では何も出さない', () => {
    render(<ExtractionRow
      extraction={extraction({ source_site: 'amazon' })}
      enrichPending={{ pending: 0, total: 0 }}
      onViewResult={noop}
    />)
    expect(screen.queryByText(/補完/)).toBeNull()
  })

  // 本番で確認(2026-10-15): col-span-full で1行使うと、操作ボタンが次の行に
  // 押し出されて縦書きになり、行が間延びしていた。進捗セルの中に収める。
  it('行を増やさない（操作ボタンを押し出さない）', () => {
    const { container } = render(<ExtractionRow
      extraction={extraction()}
      enrichPending={{ pending: 185, total: 317 }}
      onViewResult={noop}
    />)
    expect(container.querySelector('.col-span-full')).toBeNull()
    // グリッドの直下の子は6列ぶん(種別/抽出情報/出品情報/日時/進捗/操作)のまま
    expect(container.firstElementChild?.children.length).toBe(6)
  })

  // 処理中は件数が動いている途中なので出さない
  it('抽出が完了していなければ出さない', () => {
    render(<ExtractionRow
      extraction={extraction({ status: 'processing', progress: 40 })}
      enrichPending={{ pending: 50, total: 100 }}
      onViewResult={noop}
    />)
    expect(screen.queryByText(/補完/)).toBeNull()
  })
})
