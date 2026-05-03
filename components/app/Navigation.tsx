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
import {
  FileText, Database, GitBranch, Code, CheckCircle,
  LayoutDashboard, ArrowLeft, Home, HelpCircle, Settings,
} from '@/components/icons'
import { createClient } from '@/lib/supabase/client'
import { signOut } from '@/lib/actions/auth'
import { ProjectMenu } from '@/components/app/ProjectMenu'

// ── helpers ────────────────────────────────────────────────────────────────

function getProjectInitials(name?: string): string {
  if (!name) return 'P'
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 1) return words[0][0].toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function getUserInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
  }
  return email ? email.slice(0, 2).toUpperCase() : '??'
}

// CSS tooltip shown only when sidebar is collapsed
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

// ── props ──────────────────────────────────────────────────────────────────

interface NavigationProps {
  projectName?: string
  projectId?: string
  sourceSystemName?: string
  targetSystemName?: string
  blockingIssueCount?: number
  projectStatus?: string
  initialAvatarUrl?: string | null
}

const makeNavItems = (projectId?: string) => [
  { id: 'project-setup', label: 'Project Setup',     icon: FileText,        href: projectId ? `/app/projects/${projectId}` : '#',                   exact: true },
  { id: 'data-overview', label: 'Data Overview',    icon: Database,        href: projectId ? `/app/projects/${projectId}/data-overview` : '#' },
  { id: 'mapping',       label: 'Mapping',          icon: GitBranch,       href: projectId ? `/app/projects/${projectId}/mapping` : '#' },
  { id: 'transform',     label: 'Transform',        icon: Code,            href: projectId ? `/app/projects/${projectId}/transform` : '#' },
  { id: 'data-quality',  label: 'Validate',         icon: CheckCircle,     href: projectId ? `/app/projects/${projectId}/data-quality` : '#' },
  { id: 'outputs',       label: 'Migration Center', icon: LayoutDashboard, href: projectId ? `/app/projects/${projectId}/outputs` : '#' },
]

const BOTTOM_NAV = [
  { label: 'Home',     href: '/app/projects', Icon: Home },
  { label: 'Support',  href: '/app/support',  Icon: HelpCircle },
  { label: 'Settings', href: '/app/settings', Icon: Settings },
]

// ── component ──────────────────────────────────────────────────────────────

export function Navigation({
  projectName,
  projectId,
  sourceSystemName,
  targetSystemName,
  blockingIssueCount = 0,
  projectStatus = 'active',
  initialAvatarUrl = null,
}: NavigationProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [isHovered, setIsHovered] = useState(false)
  const [userName, setUserName] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)

  // Fetch user data from browser client
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

  const expanded = isHovered
  const navItems = makeNavItems(projectId)
  const projectInitials = getProjectInitials(projectName)
  const userInitials = getUserInitials(userName, userEmail)
  const displayName = userName || userEmail || 'Account'
  const projectTooltip = [projectName, sourceSystemName && targetSystemName ? `${sourceSystemName} → ${targetSystemName}` : undefined].filter(Boolean).join(' · ')

  return (
    <aside
      className={`
        fixed top-0 left-0 h-screen z-40 flex flex-col
        bg-white border-r border-gray-100
        transition-all duration-200 ease-in-out overflow-hidden
        ${expanded ? 'w-[220px] shadow-md shadow-gray-900/5' : 'w-[60px] shadow-none'}
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

      {/* Back + project info */}
      <div className="flex-shrink-0 border-b border-gray-100 px-2 py-2">
        {expanded ? (
          <Link
            href="/app/projects"
            className="flex items-center gap-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg px-2 py-1.5 transition-colors w-full"
          >
            <ArrowLeft className="w-4 h-4 flex-shrink-0" />
            <span className="whitespace-nowrap">All Projects</span>
          </Link>
        ) : (
          <Tip label="All Projects">
            <Link
              href="/app/projects"
              className="w-10 h-10 flex items-center justify-center text-gray-600 hover:bg-gray-100 rounded-lg transition-colors mx-auto"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
          </Tip>
        )}

        {expanded ? (
          projectName && projectId && (
            <div className="mt-2 pt-2 border-t border-gray-100 px-2">
              <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">Current Project</div>
              <div className="flex items-center gap-1 group/proj">
                <div className="line-clamp-2 flex-1 min-w-0 leading-tight text-sm font-medium text-gray-900">{projectName}</div>
                <div className="flex-shrink-0 opacity-0 group-hover/proj:opacity-100 transition-opacity">
                  <ProjectMenu
                    project={{
                      id: projectId,
                      name: projectName,
                      source_label: sourceSystemName || '',
                      target_label: targetSystemName || '',
                      status: projectStatus,
                    }}
                    onUpdate={() => router.refresh()}
                  />
                </div>
              </div>
              {(sourceSystemName || targetSystemName) && (
                <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                  <span className="truncate max-w-[90px]">{sourceSystemName}</span>
                  <span className="flex-shrink-0">→</span>
                  <span className="truncate max-w-[90px]">{targetSystemName}</span>
                </div>
              )}
            </div>
          )
        ) : (
          <div className="flex justify-center mt-1">
            <Tip label={projectTooltip || 'Project'}>
              <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center cursor-default">
                <span className="text-[11px] font-medium text-gray-600">{projectInitials}</span>
              </div>
            </Tip>
          </div>
        )}
      </div>

      {/* Project nav */}
      <nav className="flex-shrink-0 py-2 px-2">
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname?.startsWith(item.href + '/')
            const hasBadge = item.id === 'data-quality' && blockingIssueCount > 0

            const inner = (
              <Link
                href={item.href}
                className={`
                  flex items-center rounded-lg transition-colors duration-150
                  ${expanded ? 'gap-3 px-3 py-2 w-full' : 'justify-center w-10 h-10 mx-auto'}
                  ${isActive ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}
                `}
              >
                <span className="relative flex-shrink-0">
                  <Icon className="w-[18px] h-[18px]" />
                  {!expanded && hasBadge && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500" />
                  )}
                </span>
                {expanded && (
                  <>
                    <span className="flex-1 text-sm whitespace-nowrap">{item.label}</span>
                    {hasBadge && (
                      <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 bg-red-100 text-red-700">
                        {blockingIssueCount}
                      </span>
                    )}
                  </>
                )}
              </Link>
            )

            return (
              <li key={item.id}>
                {expanded ? inner : <Tip label={item.label}>{inner}</Tip>}
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Spacer */}
      <div className="flex-1 min-h-[40px]" />

      {/* Bottom app nav */}
      <div className="flex-shrink-0 px-2 pb-1">
        <div className="space-y-0.5">
          {BOTTOM_NAV.map(({ label, href, Icon }) => {
            const isBottomActive = pathname === href
            const btn = (
              <Link
                href={href}
                className={`flex items-center rounded-lg transition-colors duration-150
                  ${expanded ? 'gap-3 px-3 py-2 w-full' : 'justify-center w-10 h-10 mx-auto'}
                  ${isBottomActive ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'}`}
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
                    <span className="text-xs font-semibold text-white">{userInitials}</span>
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
                      className="w-8 h-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                      <span className="text-xs font-semibold text-white">{userInitials}</span>
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
  )
}
