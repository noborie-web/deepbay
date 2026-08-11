// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '@/app/(auth)/login/page'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))

describe('LoginPage', () => {
  beforeEach(() => {
    mocks.createClient.mockReset()
    mocks.push.mockReset()
  })

  it('restores the form and shows an error when Supabase is not configured', async () => {
    mocks.createClient.mockImplementation(() => {
      throw new Error('Supabase URL is required')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }))

    expect(await screen.findByText('ログイン設定が未完了です。Supabaseの環境変数を確認してください。')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'ログイン' }) as HTMLButtonElement).disabled).toBe(false)
    expect(mocks.push).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })
})
