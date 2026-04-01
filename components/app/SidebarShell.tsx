'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useIdleTimeout } from '@/lib/hooks/useIdleTimeout'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Home, HelpCircle, Settings } from '@/components/icons'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/lib/actions/auth'

interface SidebarShellProps {
  children: React.ReactNode
}

function getUserInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
  }
  return email ? email.slice(0, 2).toUpperCase() : '??'
}

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative group/tip">
      {children}
      <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-gray-900 text-white text-xs rounded-md opacity-0 group-hover/tip:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
        {label}
      </div>
    </div>
  )
}

const NAV_ITEMS = [
  { label: 'Home',     href: '/app/projects', Icon: Home,       matchFn: (p: string) => p === '/app/projects' || p === '/app' },
  { label: 'Support',  href: '/app/support',  Icon: HelpCircle, matchFn: (p: string) => p.startsWith('/app/support') },
  { label: 'Settings', href: '/app/settings', Icon: Settings,   matchFn: (p: string) => p === '/app/settings' || p === '/app/profile' },
]

export default function SidebarShell({ children }: SidebarShellProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [isHovered, setIsHovered] = useState(false)
  const [isPopoverOpen, setIsPopoverOpen] = useState(false)
  const [popoverCoords, setPopoverCoords] = useState({ bottom: 0, left: 0 })
  const [userName, setUserName] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)

  const avatarRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // ── Idle session timeout ───────────────────────────────────────────────────
  const handleIdleTimeout = useCallback(async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login?reason=timeout')
  }, [router])

  useIdleTimeout(handleIdleTimeout)

  // Fetch user data
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setUserName(user.user_metadata?.full_name ?? null)
        setUserEmail(user.email ?? null)
      }
    })
  }, [])

  // Close popover on outside click
  useEffect(() => {
    if (!isPopoverOpen) return
    function handler(e: MouseEvent) {
      const t = e.target as Node
      if (
        popoverRef.current && !popoverRef.current.contains(t) &&
        avatarRef.current && !avatarRef.current.contains(t)
      ) setIsPopoverOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isPopoverOpen])

  // Close popover on Escape
  useEffect(() => {
    if (!isPopoverOpen) return
    function handler(e: KeyboardEvent) { if (e.key === 'Escape') setIsPopoverOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isPopoverOpen])

  const handleSignOut = async () => {
    setIsPopoverOpen(false)
    await signOut()
    router.push('/login')
  }

  const openPopover = () => {
    if (!isPopoverOpen && avatarRef.current) {
      const rect = avatarRef.current.getBoundingClientRect()
      setPopoverCoords({ bottom: window.innerHeight - rect.top + 8, left: rect.left })
    }
    setIsPopoverOpen(o => !o)
  }

  const expanded = isHovered
  const initials = getUserInitials(userName, userEmail)
  const displayName = userName || userEmail || 'Account'

  return (
    <div className="h-screen bg-gray-50 overflow-hidden">
      {/* Fixed overlay sidebar */}
      <aside
        className={`
          fixed top-0 left-0 h-screen z-40 flex flex-col
          bg-white border-r border-gray-200
          transition-all duration-200 ease-in-out overflow-hidden
          ${expanded ? 'w-[200px] shadow-xl shadow-gray-900/10' : 'w-[60px] shadow-none'}
        `}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => { if (!isPopoverOpen) setIsHovered(false) }}
      >
        {/* Logo */}
        <div className="flex-shrink-0 h-14 border-b border-gray-200 flex items-center px-3">
          <Link href="/app/projects" className="flex items-center gap-2.5 min-w-0">
            <img src="/Mine Logo no background.png" alt="Mine" className="h-7 w-auto flex-shrink-0" />
            {expanded && <span className="text-lg font-bold tracking-tight text-gray-900 whitespace-nowrap">Mine</span>}
          </Link>
        </div>

        {/* Spacer */}
        <div className="flex-1 min-h-0" />

        {/* Nav items */}
        <div className="flex-shrink-0 px-2 pb-1">
          <div className="space-y-0.5">
            {NAV_ITEMS.map(({ label, href, Icon, matchFn }) => {
              const isActive = matchFn(pathname)
              const btn = (
                <Link
                  href={href}
                  className={`
                    flex items-center rounded-lg transition-colors
                    ${expanded ? 'gap-3 px-3 py-2 w-full' : 'justify-center w-10 h-10 mx-auto'}
                    ${isActive ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}
                  `}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  {expanded && <span className="text-sm whitespace-nowrap">{label}</span>}
                </Link>
              )
              return (
                <div key={href}>
                  {expanded ? btn : <Tip label={label}>{btn}</Tip>}
                </div>
              )
            })}
          </div>
        </div>

        {/* Divider */}
        <div className="mx-3 my-1.5 border-t border-gray-200 flex-shrink-0" />

        {/* Avatar */}
        <div className={`flex-shrink-0 pb-4 ${expanded ? 'px-2' : 'flex justify-center'}`}>
          {expanded ? (
            <button
              ref={avatarRef}
              onClick={openPopover}
              className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-semibold text-white">{initials}</span>
              </div>
              <span className="text-sm text-gray-700 truncate max-w-[120px]">{displayName}</span>
            </button>
          ) : (
            <Tip label={displayName}>
              <button
                ref={avatarRef}
                onClick={openPopover}
                className="w-10 h-10 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
                  <span className="text-xs font-semibold text-white">{initials}</span>
                </div>
              </button>
            </Tip>
          )}
        </div>
      </aside>

      {/* Popover portal */}
      {isPopoverOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="fixed w-[220px] bg-white border border-gray-200 rounded-xl shadow-lg z-[200] p-3"
          style={{ bottom: popoverCoords.bottom, left: popoverCoords.left }}
        >
          <div className="px-1 pb-2">
            <div className="text-sm font-medium text-gray-900 truncate">{displayName}</div>
            {userEmail && <div className="text-xs text-gray-500 truncate mt-0.5">{userEmail}</div>}
          </div>
          <div className="border-t border-gray-200 my-2" />
          <Link
            href="/app/settings"
            onClick={() => setIsPopoverOpen(false)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <Settings className="w-4 h-4 text-gray-500 flex-shrink-0" />
            Settings
          </Link>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-red-600 hover:bg-red-50 transition-colors mt-0.5"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign out
          </button>
        </div>,
        document.body
      )}

      {/* Main content — always 60px left padding */}
      <div className="h-full pl-[60px] overflow-auto min-w-0">{children}</div>
    </div>
  )
}
