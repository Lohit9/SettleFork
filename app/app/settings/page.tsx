import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/lib/actions/auth'
import SidebarShell from '@/components/app/SidebarShell'
import { Button } from '@/components/ui/button'
import { SecuritySection } from './SecuritySection'
import { PreferencesSection } from './PreferencesSection'
import { DangerZoneSection } from './DangerZoneSection'
import { EditButton } from './EditButton'

function getInitials(fullName: string | null | undefined, email: string): string {
  if (fullName?.trim()) {
    const parts = fullName.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return parts[0].slice(0, 2).toUpperCase()
  }
  return email.slice(0, 2).toUpperCase()
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single()

  const fullName: string | null =
    profile?.full_name || user.user_metadata?.full_name || null
  const initials = getInitials(fullName, user.email ?? '')
  const isVerified = !!user.email_confirmed_at

  return (
    <SidebarShell>
      <div className="flex-1 bg-gray-50 min-h-screen">
        {/* Header */}
        <div className="border-b border-gray-200 bg-white px-8 py-5 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage your account and preferences</p>
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

        {/* Content */}
        <div className="px-8 py-6 max-w-3xl space-y-4">
          {/* Account */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center gap-4 mb-4">
              {/* Avatar */}
              <div className="w-14 h-14 rounded-full bg-[#6C5CE7] flex items-center justify-center flex-shrink-0">
                <span className="text-white font-medium text-lg">{initials}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {fullName || user.email}
                </p>
                <p className="text-sm text-gray-500 truncate">{user.email}</p>
              </div>
              <EditButton />
            </div>

            <div className="border-t border-gray-100 pt-4 grid grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Organization</p>
                <p className="text-sm text-gray-900">Mine (Personal)</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Account created</p>
                <p className="text-sm text-gray-900">{formatDate(user.created_at)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Email status</p>
                {isVerified ? (
                  <p className="text-sm font-medium text-green-600">Verified</p>
                ) : (
                  <p className="text-sm font-medium text-amber-600">Unverified</p>
                )}
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Plan</p>
                <p className="text-sm text-gray-900 flex items-center gap-1.5">
                  Early Access
                  <span className="text-[11px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">
                    Beta
                  </span>
                </p>
              </div>
            </div>
          </div>

          {/* Security */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
              Security
            </p>
            <SecuritySection />
          </div>

          {/* API Access */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
              API Access
            </p>
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-gray-900">API access</p>
                <span className="text-xs bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full">
                  Coming soon
                </span>
              </div>
              <p className="text-sm text-gray-500">
                Generate API keys to integrate Mine with your CI/CD pipeline or custom tooling. API
                access will be available in a future release.
              </p>
            </div>
          </div>

          {/* Preferences */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
              Preferences
            </p>
            <PreferencesSection />
          </div>

          {/* Danger Zone */}
          <DangerZoneSection />
        </div>
      </div>
    </SidebarShell>
  )
}

