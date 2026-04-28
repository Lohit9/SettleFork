'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Settings tab nav. The parent layout is a Server Component (so the
// page bodies stay RSC-rendered for data-fetching); this small
// Client Component owns just the active-state styling, which needs
// `usePathname()`.
//
// Active-state rules — match the existing settings pages:
//   - General is active iff pathname is exactly '/app/settings'.
//     A startsWith match would steal the active state from the
//     other tabs since their paths are children of /app/settings.
//   - Organization is active for '/app/settings/organization' and
//     any future sub-paths.
//   - SSO is active for '/app/settings/sso' and any future sub-paths
//     (B-2-c-ii through -v will add nested routes here).
//
// Styling intentionally mirrors the previous inline tab block in
// `app/app/settings/page.tsx:55-76` so this is a no-visual-change
// extraction.

interface TabDef {
  href: string
  label: string
  isActive: (pathname: string) => boolean
}

const TABS: TabDef[] = [
  {
    href: '/app/settings',
    label: 'General',
    isActive: (p) => p === '/app/settings',
  },
  {
    href: '/app/settings/organization',
    label: 'Organization',
    isActive: (p) => p.startsWith('/app/settings/organization'),
  },
  {
    href: '/app/settings/sso',
    label: 'SSO',
    isActive: (p) => p.startsWith('/app/settings/sso'),
  },
]

export function SettingsTabs() {
  const pathname = usePathname()
  return (
    <div className="px-8 flex gap-6">
      {TABS.map((tab) => {
        const active = tab.isActive(pathname)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={
              active
                ? 'pb-2.5 text-sm font-medium text-blue-600 border-b-2 border-blue-600'
                : 'pb-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent'
            }
            data-testid={`settings-tab-${tab.label.toLowerCase()}`}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
