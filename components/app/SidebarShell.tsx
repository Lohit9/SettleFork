'use client'

import { useState, useEffect, useCallback } from 'react'
import { useIdleTimeout } from '@/lib/hooks/useIdleTimeout'
import Link from 'next/link'
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from '@/components/ui/popover'
import { usePathname, useRouter } from 'next/navigation'
import { Home, HelpCircle, Settings } from '@/components/icons'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/lib/actions/auth'
import type { Organization } from '@/lib/types/organizations'
import type { OrgRole } from '@/lib/types/organizations'

interface OrgWithRole extends Organization {
  role: OrgRole
}

interface SidebarShellProps {
  children: React.ReactNode
  initialOrgs: OrgWithRole[]
  initialActiveOrgId: string | null
  initialUserName: string
  initialUserEmail: string
  initialAvatarUrl?: string | null
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
  { label: 'Settings', href: '/app/settings', Icon: Settings,   matchFn: (p: string) => p.startsWith('/app/settings') || p === '/app/profile' },
]

export default function SidebarShell({
  children,
  initialOrgs,
  initialActiveOrgId,
  initialUserName,
  initialUserEmail,
  initialAvatarUrl,
}: SidebarShellProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [isHovered, setIsHovered] = useState(false)
  // Seeded from server — no loading flash
  const [userName] = useState<string>(initialUserName)
  const [userEmail] = useState<string>(initialUserEmail)

  // Org switcher state — seeded from server
  const [orgs] = useState<OrgWithRole[]>(initialOrgs)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(initialActiveOrgId)

  // ── Idle session timeout ───────────────────────────────────────────────────
  const handleIdleTimeout = useCallback(async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login?reason=timeout')
  }, [router])

  useIdleTimeout(handleIdleTimeout)

  const handleSignOut = async () => {
    await signOut()
    router.push('/login')
  }

  const activeOrg = orgs.find((o) => o.id === activeOrgId)
  const orgInitial = activeOrg ? activeOrg.name.charAt(0).toUpperCase() : '?'
  const hasMultipleOrgs = orgs.length > 1

  const switchOrg = (orgId: string) => {
    setActiveOrgId(orgId)
    document.cookie = `settle-active-org=${orgId};path=/;max-age=${365 * 24 * 60 * 60}`
    router.push('/app/projects')
    router.refresh()
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
          bg-white border-r border-gray-100
          transition-all duration-200 ease-in-out overflow-hidden
          ${expanded ? 'w-[200px] shadow-md shadow-gray-900/5' : 'w-[60px] shadow-none'}
        `}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Logo */}
        <div className="flex-shrink-0 h-14 border-b border-gray-100 flex items-center px-3">
          <Link href="/app/projects" className="flex items-center gap-2.5 min-w-0">
            {expanded ? (
              <img src="/images/logos/settle-logo-full.svg" alt="Settle" className="h-7 w-auto" />
            ) : (
              <img src="/images/logos/settle-logo-mark.png" alt="Settle" className="h-7 w-7 object-contain" />
            )}
          </Link>
        </div>

        {/* Org switcher (Radix Popover when multi-org; inert button when single-org) */}
        {activeOrg && (
          <div className={`flex-shrink-0 pt-3 pb-1 ${expanded ? 'px-2' : 'flex justify-center'}`}>
            {hasMultipleOrgs ? (
              <Popover>
                {expanded ? (
                  <PopoverTrigger asChild>
                    <button className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg transition-colors hover:bg-gray-100 cursor-pointer">
                      <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-[11px] font-medium text-gray-600">{orgInitial}</span>
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <span className="text-sm font-medium text-gray-900 truncate block">{activeOrg.name}</span>
                        <span className="text-[10px] text-gray-400 capitalize">{activeOrg.role}</span>
                      </div>
                      <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                      </svg>
                    </button>
                  </PopoverTrigger>
                ) : (
                  <Tip label={activeOrg.name}>
                    <PopoverTrigger asChild>
                      <button className="w-10 h-10 flex items-center justify-center rounded-lg transition-colors hover:bg-gray-100 cursor-pointer">
                        <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
                          <span className="text-[11px] font-medium text-gray-600">{orgInitial}</span>
                        </div>
                      </button>
                    </PopoverTrigger>
                  </Tip>
                )}
                <PopoverPortal>
                  <PopoverContent
                    side="right"
                    align="start"
                    sideOffset={8}
                    className="w-[240px] p-2"
                  >
                    <p className="px-2 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">Workspaces</p>
                    {orgs.map((org) => (
                      <PopoverClose asChild key={org.id}>
                        <button
                          onClick={() => switchOrg(org.id)}
                          className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors ${
                            org.id === activeOrgId ? 'bg-blue-50' : 'hover:bg-gray-50'
                          }`}
                        >
                          <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${
                            org.id === activeOrgId
                              ? 'bg-gradient-to-br from-blue-600 to-blue-700'
                              : 'bg-gray-200'
                          }`}>
                            <span className={`text-xs font-bold ${org.id === activeOrgId ? 'text-white' : 'text-gray-600'}`}>
                              {org.name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className={`text-sm truncate block ${org.id === activeOrgId ? 'font-medium text-blue-700' : 'text-gray-700'}`}>
                              {org.name}
                            </span>
                          </div>
                          <span className="text-[10px] text-gray-400 capitalize flex-shrink-0">{org.role}</span>
                          {org.id === activeOrgId && (
                            <svg className="w-4 h-4 text-blue-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      </PopoverClose>
                    ))}
                  </PopoverContent>
                </PopoverPortal>
              </Popover>
            ) : (
              // Single-org: inert button (no popover to open)
              expanded ? (
                <div className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg transition-colors cursor-default">
                  <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-[11px] font-medium text-gray-600">{orgInitial}</span>
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <span className="text-sm font-medium text-gray-900 truncate block">{activeOrg.name}</span>
                    <span className="text-[10px] text-gray-400 capitalize">{activeOrg.role}</span>
                  </div>
                </div>
              ) : (
                <Tip label={activeOrg.name}>
                  <div className="w-10 h-10 flex items-center justify-center rounded-lg transition-colors cursor-default">
                    <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
                      <span className="text-[11px] font-medium text-gray-600">{orgInitial}</span>
                    </div>
                  </div>
                </Tip>
              )
            )}
          </div>
        )}

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
                    flex items-center rounded-lg transition-colors duration-150
                    ${expanded ? 'gap-3 px-3 py-2 w-full' : 'justify-center w-10 h-10 mx-auto'}
                    ${isActive ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}
                  `}
                >
                  <Icon className="w-[18px] h-[18px] flex-shrink-0" />
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
        <div className="mx-3 my-1.5 border-t border-gray-100 flex-shrink-0" />

        {/* Avatar with Radix Popover (PR E.1) */}
        <div className={`flex-shrink-0 pb-4 ${expanded ? 'px-2' : 'flex justify-center'}`}>
          <Popover>
            {expanded ? (
              <PopoverTrigger asChild>
                <button className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors cursor-pointer">
                  {initialAvatarUrl ? (
                    <img
                      src={initialAvatarUrl}
                      alt={displayName}
                      className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-semibold text-white">{initials}</span>
                    </div>
                  )}
                  <span className="text-sm text-gray-700 truncate max-w-[120px]">{displayName}</span>
                </button>
              </PopoverTrigger>
            ) : (
              <Tip label={displayName}>
                <PopoverTrigger asChild>
                  <button className="w-10 h-10 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-colors cursor-pointer">
                    {initialAvatarUrl ? (
                      <img
                        src={initialAvatarUrl}
                        alt={displayName}
                        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                        <span className="text-xs font-semibold text-white">{initials}</span>
                      </div>
                    )}
                  </button>
                </PopoverTrigger>
              </Tip>
            )}
            <PopoverPortal>
              <PopoverContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-[220px] p-3"
              >
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

      {/* Main content — always 60px left padding */}
      <div className="h-full pl-[60px] overflow-auto min-w-0">{children}</div>
    </div>
  )
}
