// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '@/components/layout/Sidebar'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signOut: vi.fn(),
  createClient: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/extraction',
  useRouter: () => ({ push: mocks.push }),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: mocks.createClient,
}))

describe('Sidebar', () => {
  beforeEach(() => {
    mocks.push.mockReset()
    mocks.signOut.mockReset().mockResolvedValue({ error: null })
    mocks.createClient.mockReset().mockReturnValue({ auth: { signOut: mocks.signOut } })
  })

  it('keeps every internal navigation item on an implemented route', () => {
    render(<Sidebar />)

    expect(screen.getByRole('link', { name: '抽出管理' })).toHaveAttribute('href', '/extraction')
    expect(screen.getByRole('link', { name: '自動抽出' })).toHaveAttribute('href', '/auto-extraction')
    expect(screen.getByRole('link', { name: '抽出設定' })).toHaveAttribute('href', '/extraction-settings')
    expect(screen.getByRole('link', { name: '在庫管理' })).toHaveAttribute('href', '/inventory')
    expect(screen.getByRole('link', { name: '会員情報' })).toHaveAttribute('href', '/account')
    expect(screen.getByRole('link', { name: '料金プラン' })).toHaveAttribute('href', '/plan')
    expect(screen.getByRole('link', { name: '規約情報' })).toHaveAttribute('href', '/terms')
    expect(screen.queryByRole('link', { name: 'ログアウト' })).not.toBeInTheDocument()
  })

  it('opens the manual site safely in a new tab', () => {
    render(<Sidebar />)

    const manual = screen.getByRole('link', { name: 'マニュアル' })
    expect(manual).toHaveAttribute('href', 'https://deepbay.info')
    expect(manual).toHaveAttribute('target', '_blank')
    expect(manual).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('signs out before navigating to the login page', async () => {
    let resolveSignOut: (value: { error: null }) => void = () => {}
    mocks.signOut.mockReturnValue(new Promise((resolve) => { resolveSignOut = resolve }))
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    expect(mocks.signOut).toHaveBeenCalledOnce()
    expect(mocks.push).not.toHaveBeenCalled()

    resolveSignOut({ error: null })
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/login'))
  })
})
