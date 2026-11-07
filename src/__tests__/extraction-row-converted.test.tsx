// @vitest-environment jsdom
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import ExtractionRow from '@/components/extraction/ExtractionRow'
import type { Extraction, SellerAccount } from '@/types/database'

// ユーザー要望(2026-11-07): miyabi-24 から akebono-32 向けに変換した抽出を、
// 一覧で見分けられるようにしたい。
//
// 変換(ListForSellerModal)で作る抽出は、元の名前に「（出品先セラー）」を
// 付けている。それを手がかりに背景色を変える。

function makeSeller(overrides: Partial<SellerAccount> = {}): SellerAccount {
  return {
    id: 'seller-akebono', user_id: 'user-1', seller_id: 'akebono-32',
    display_name: null, is_default: false, created_at: '2026-09-25T00:00:00.000Z',
    ...overrides,
  }
}

function makeExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    id: 'ext-1', user_id: 'user-1',
    source_url: 'https://jp.mercari.com/search?keyword=n64', source_site: 'mercari',
    seller_account_id: 'seller-akebono', category_id: null, bulk_edit_setting_id: null,
    status: 'completed', progress: 100, name: null, memo: '', edited_at: null,
    is_bulk: true, extracted_at: '2026-11-01T00:00:00.000Z', error_message: null,
    exclusion_summary: null,
    created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function rowOf(extraction: Extraction): HTMLElement {
  const { container } = render(
    <ExtractionRow extraction={extraction} onViewResult={vi.fn()} />,
  )
  return container.firstElementChild as HTMLElement
}

describe('ExtractionRow: 別セラー向けに変換した抽出', () => {
  it('背景色を変えて見分けられるようにする', () => {
    const row = rowOf(makeExtraction({
      name: '廃盤（akebono-32）',
      seller_account: makeSeller(),
    }))
    expect(row.className).toContain('bg-violet-50')
  })

  it('表示名を付けているセラーでも見分けられる', () => {
    const row = rowOf(makeExtraction({
      name: '廃盤（あけぼの）',
      seller_account: makeSeller({ display_name: 'あけぼの' }),
    }))
    expect(row.className).toContain('bg-violet-50')
  })

  it('通常の抽出は背景色を変えない', () => {
    const row = rowOf(makeExtraction({ name: '廃盤', seller_account: makeSeller() }))
    expect(row.className).not.toContain('bg-violet-50')
  })

  it('別のセラー名が付いていても、その抽出のセラーと違えば変えない', () => {
    // 「（miyabi-24）」で終わる名前を akebono-32 の抽出に付けただけの場合。
    // 変換で作った抽出は、必ず自分のセラー名が付く。
    const row = rowOf(makeExtraction({
      name: '廃盤（miyabi-24）',
      seller_account: makeSeller(),
    }))
    expect(row.className).not.toContain('bg-violet-50')
  })

  it('セラー未設定の抽出は変えない', () => {
    const row = rowOf(makeExtraction({ name: '廃盤（akebono-32）', seller_account_id: null }))
    expect(row.className).not.toContain('bg-violet-50')
  })
})
