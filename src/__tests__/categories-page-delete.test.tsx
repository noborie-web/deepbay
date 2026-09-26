// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 本番で確認した不具合(2026-09-26): 親カテゴリ222を削除しようとしても何も
// 起きなかった。その抽出が参照しているため外部キー制約で拒否されるのに、
// 画面がエラーを捨てていた。理由の表示と、末端カテゴリへの付け替えを検証する。
const mocks = vi.hoisted(() => ({
  deleteError: null as { code?: string; message?: string } | null,
  updates: [] as Array<Record<string, unknown>>,
}))

const categories = [
  { id: 'cat-1', user_id: 'u1', ebay_category_id: '222', name: 'Diecast & Toy Vehicles', condition_map: null, sort_order: 0 },
]

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.order = async () => ({ data: categories, error: null })
      chain.delete = () => ({ eq: async () => ({ error: mocks.deleteError }) })
      chain.update = (values: Record<string, unknown>) => ({
        eq: async () => { mocks.updates.push(values); return { error: null } },
      })
      chain.insert = async () => ({ error: null })
      return chain
    },
  }),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import CategoriesPage from '@/app/(dashboard)/categories/page'

describe('出品カテゴリー管理', () => {
  beforeEach(() => {
    mocks.deleteError = null
    mocks.updates.length = 0
    // 222は親カテゴリ、180506は末端カテゴリ
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('parent=222')) {
        return { ok: true, json: async () => [{ id: '180273', name: 'Cars, Trucks & Vans' }] }
      }
      return { ok: true, json: async () => [] }
    }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('抽出が使っているカテゴリーは、削除できない理由を表示する', async () => {
    mocks.deleteError = { code: '23503', message: 'violates foreign key constraint' }
    const user = userEvent.setup()
    render(<CategoriesPage />)

    await user.click(await screen.findByRole('button', { name: '登録済みカテゴリー管理' }))
    await user.click(await screen.findByRole('button', { name: '削除' }))

    expect(await screen.findByText(/使っている抽出があるため削除できません/)).toBeInTheDocument()
  })

  it('末端カテゴリーのIDに付け替えられる', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('180506')
    const user = userEvent.setup()
    render(<CategoriesPage />)

    await user.click(await screen.findByRole('button', { name: '登録済みカテゴリー管理' }))
    await user.click(await screen.findByRole('button', { name: 'IDを変更' }))

    await waitFor(() => expect(mocks.updates).toEqual([{ ebay_category_id: '180506' }]))
  })

  it('親カテゴリーのIDには付け替えない', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('222')
    const user = userEvent.setup()
    render(<CategoriesPage />)

    await user.click(await screen.findByRole('button', { name: '登録済みカテゴリー管理' }))
    await user.click(await screen.findByRole('button', { name: 'IDを変更' }))

    await waitFor(() => expect(mocks.updates).toEqual([]))
  })
})
