import { signOut } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { SettingsTabs } from './SettingsTabs'

// Shared chrome for all `/app/settings/*` pages — extracted from the
// duplicated 18-line header that used to live verbatim in
// `app/app/settings/page.tsx:43-77` and
// `app/app/settings/organization/page.tsx:44-78`.
//
// The layout owns:
//   - The gray-50 page background and min-height
//   - The white header band with title, subtitle, and Sign out button
//   - The horizontal tab nav (extracted to <SettingsTabs/> for
//     `usePathname()` access; see that file's docstring)
//
// Per-route content is rendered in `<main>` below. Page bodies stay
// Server Components — only the tab nav is a Client Component, and
// it doesn't render any of the page data.
//
// B-2-c-i adds the third "SSO" tab. Future B-2-c sub-prompts that
// add nested routes (e.g. `/app/settings/sso/domains`) need NO
// changes here; the SSO tab's `startsWith('/app/settings/sso')`
// match already handles them.

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 bg-gray-50 min-h-screen">
      <div className="border-b border-gray-200 bg-white">
        <div className="px-8 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Manage your account and preferences
            </p>
          </div>
          <form action={signOut}>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400 text-sm"
            >
              Sign out
            </Button>
          </form>
        </div>
        <SettingsTabs />
      </div>
      <main>{children}</main>
    </div>
  )
}
