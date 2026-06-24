'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Gift,
  RefreshCw,
  Settings,
  Cloud,
  User,
  CreditCard,
  BookOpen,
  FileText,
  LogOut,
  Bell,
  Menu,
} from 'lucide-react'
import clsx from 'clsx'

const NAV = [
  {
    section: '抽出',
    items: [
      { label: '抽出管理', href: '/extraction', icon: Gift },
      { label: '自動抽出', href: '/auto-extraction', icon: RefreshCw },
      { label: '抽出設定', href: '/extraction-settings', icon: Settings },
    ],
  },
  {
    section: '在庫',
    items: [
      { label: '在庫管理', href: '/inventory', icon: Cloud },
    ],
  },
]

const BOTTOM_NAV = [
  { label: '会員情報', href: '/account', icon: User },
  { label: '料金プラン', href: '/plan', icon: CreditCard },
  { label: 'マニュアル', href: '/manual', icon: BookOpen },
  { label: '規約情報', href: '/terms', icon: FileText },
  { label: 'ログアウト', href: '/logout', icon: LogOut },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="flex flex-col w-52 min-h-screen bg-[#1c1c1c] text-[#c9b97a] shrink-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-[#2e2e2e]">
        <Menu size={18} className="text-[#888]" />
        <span className="text-xl font-bold tracking-wide text-[#c9b97a]">DeepBay</span>
        <Bell size={16} className="ml-auto text-[#888]" />
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map((group) => (
          <div key={group.section} className="mb-2">
            <p className="px-4 py-2 text-xs text-[#666] uppercase tracking-widest">
              {group.section}
            </p>
            {group.items.map(({ label, href, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'flex items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                  pathname === href
                    ? 'bg-[#2a2a2a] text-[#c9b97a] font-medium'
                    : 'text-[#a0a0a0] hover:bg-[#242424] hover:text-[#c9b97a]',
                )}
              >
                <Icon size={16} />
                {label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* Bottom nav */}
      <div className="border-t border-[#2e2e2e] py-2">
        {BOTTOM_NAV.map(({ label, href, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-3 px-4 py-2 text-sm text-[#888] hover:text-[#c9b97a] hover:bg-[#242424] transition-colors"
          >
            <Icon size={15} />
            {label}
          </Link>
        ))}
      </div>
    </aside>
  )
}
