'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from '@/components/ui/popover'
import { usePathname, useRouter } from 'next/navigation'
import { Database, SlidersHorizontal, Package, Home, LifeBuoy, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/lib/actions/auth'

function getUserInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
  }
  return email ? email.slice(0, 2).toUpperCase() : '??'
}

// Tooltip shown on hover — the rail is icon-only, so every item needs a label.
function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative group">
      {children}
      <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-gray-900 text-white text-xs rounded-md whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 z-50">
        {label}
        <div className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-gray-900" />
      </div>
    </div>
  )
}

interface NavigationProps {
  projectName?: string
  projectId?: string
  sourceSystemName?: string
  targetSystemName?: string
  blockingIssueCount?: number
  projectStatus?: string
  initialAvatarUrl?: string | null
}

// Three-stage rail matching the Settle MVP design (src/app.jsx): Setup → Configure → Export.
const makeNavItems = (projectId?: string) => [
  { id: 'setup',     label: 'Setup',     icon: Database,          href: projectId ? `/app/projects/${projectId}` : '#',            exact: true },
  { id: 'configure', label: 'Configure', icon: SlidersHorizontal, href: projectId ? `/app/projects/${projectId}/generating` : '#' },
  { id: 'export',    label: 'Export',    icon: Package,           href: projectId ? `/app/projects/${projectId}/outputs` : '#' },
]

const BOTTOM_NAV: { label: string; href: string; icon: LucideIcon }[] = [
  { label: 'Home',     href: '/app/projects', icon: Home },
  { label: 'Help',     href: '/app/support',  icon: LifeBuoy },
  { label: 'Settings', href: '/app/settings', icon: Settings },
]

function RailLink({
  href,
  icon: Icon,
  label,
  active,
  badge,
}: {
  href: string
  icon: LucideIcon
  label: string
  active: boolean
  badge?: number
}) {
  return (
    <Tip label={label}>
      <Link
        href={href}
        className={`w-10 h-10 flex items-center justify-center rounded-md transition-colors relative ${
          active
            ? 'bg-[#F3F4F6] text-[#111827]'
            : 'text-[#6B7280] hover:bg-[#F9FAFB] hover:text-[#111827]'
        }`}
      >
        <Icon className="w-[18px] h-[18px]" strokeWidth={1.6} />
        {badge ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-[#EF4444] text-white text-[10px] font-medium flex items-center justify-center">
            {badge}
          </span>
        ) : null}
      </Link>
    </Tip>
  )
}

export function Navigation({
  projectId,
  blockingIssueCount = 0,
  initialAvatarUrl = null,
}: NavigationProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [userName, setUserName] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setUserName(user.user_metadata?.full_name ?? null)
        setUserEmail(user.email ?? null)
      }
    })
  }, [])

  const handleSignOut = async () => {
    await signOut()
    router.push('/login')
  }

  const navItems = makeNavItems(projectId)
  const userInitials = getUserInitials(userName, userEmail)
  const displayName = userName || userEmail || 'Account'

  return (
    <aside className="fixed top-0 left-0 h-screen z-40 w-[60px] bg-white border-r border-[#E5E7EB] flex flex-col items-center py-3">
      <Link href="/app/projects" className="flex items-center justify-center w-9 h-9" aria-label="Settle">
        <img
          src="/images/logos/settle-logo-mark.png"
          alt="Settle"
          width={36}
          height={36}
          className="w-9 h-9 object-contain"
        />
      </Link>
      <div className="w-8 h-px bg-[#E5E7EB] my-2.5" />

      <div className="flex flex-col items-center gap-1.5">
        {navItems.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname?.startsWith(item.href + '/')
          const badge = item.id === 'configure' && blockingIssueCount > 0 ? blockingIssueCount : undefined
          return (
            <RailLink
              key={item.id}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={!!active}
              badge={badge}
            />
          )
        })}
      </div>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1.5">
        {BOTTOM_NAV.map((item) => (
          <RailLink
            key={item.href}
            href={item.href}
            icon={item.icon}
            label={item.label}
            active={pathname === item.href}
          />
        ))}

        <Popover>
          <Tip label={displayName}>
            <PopoverTrigger asChild>
              <button className="mt-1 w-8 h-8 rounded-full bg-[#F3F4F6] border border-[#E5E7EB] flex items-center justify-center text-[11px] text-[#6B7280] font-medium hover:bg-[#E5E7EB] transition-colors overflow-hidden">
                {initialAvatarUrl ? (
                  <img src={initialAvatarUrl} alt={displayName} className="w-8 h-8 rounded-full object-cover" />
                ) : (
                  userInitials
                )}
              </button>
            </PopoverTrigger>
          </Tip>
          <PopoverPortal>
            <PopoverContent side="right" align="end" sideOffset={8} className="w-[220px] p-3">
              <div className="px-1 pb-2">
                <div className="text-sm font-medium text-gray-900 truncate">{displayName}</div>
                {userEmail && <div className="text-xs text-gray-500 truncate mt-0.5">{userEmail}</div>}
              </div>
              <div className="border-t border-gray-200 my-2" />
              <PopoverClose asChild>
                <Link
                  href="/app/settings"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  <Settings className="w-4 h-4 text-gray-500 flex-shrink-0" />
                  Settings
                </Link>
              </PopoverClose>
              <PopoverClose asChild>
                <button
                  onClick={handleSignOut}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-red-600 hover:bg-red-50 transition-colors mt-0.5"
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Sign out
                </button>
              </PopoverClose>
            </PopoverContent>
          </PopoverPortal>
        </Popover>
      </div>
    </aside>
  )
}
