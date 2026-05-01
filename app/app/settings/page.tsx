import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getUserOrganizationsWithCounts, getUserPreferences } from '@/lib/actions/profile'
import { SecuritySection } from './SecuritySection'
import { NewPreferencesSection } from './NewPreferencesSection'
import { DangerZoneSection } from './DangerZoneSection'
import { ProfileCard } from './ProfileCard'

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
  const isVerified = !!user.email_confirmed_at

  const userOrgs = await getUserOrganizationsWithCounts()
  const cookieStore = await cookies()
  const activeOrgId = cookieStore.get('settle-active-org')?.value
    ?? cookieStore.get('mine-active-org')?.value
    ?? null
  const currentOrg = userOrgs.find((o) => o.id === activeOrgId) ?? userOrgs[0]

  const preferences = await getUserPreferences()

  return (
    <div className="px-8 py-6 max-w-3xl space-y-4">
      <ProfileCard
        initialName={fullName}
        email={user.email ?? ''}
        initialAvatarUrl={profile?.avatar_url ?? null}
        isVerified={isVerified}
        orgName={currentOrg?.name ?? 'Personal'}
        createdAt={formatDate(user.created_at)}
      />

      {userOrgs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
            Your organizations
          </p>
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {userOrgs.map((org) => {
              const isCurrent =
                org.id === activeOrgId ||
                (!activeOrgId && userOrgs[0]?.id === org.id)
              return (
                <div key={org.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold flex-shrink-0">
                    {org.name[0]?.toUpperCase() ?? '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{org.name}</p>
                    <p className="text-xs text-gray-500">
                      {org.role.charAt(0).toUpperCase() + org.role.slice(1)} ·{' '}
                      {org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
                    </p>
                  </div>
                  {isCurrent ? (
                    <span className="text-[10px] font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex-shrink-0">
                      Current
                    </span>
                  ) : (
                    <a
                      href={`/app/settings/organization?switch=${org.id}`}
                      className="text-xs text-primary hover:text-primary/80 font-medium transition-colors flex-shrink-0"
                    >
                      Switch →
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
          Security
        </p>
        <SecuritySection />
      </div>

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
            Generate API keys to integrate Settle with your CI/CD pipeline or custom tooling. API
            access will be available in a future release.
          </p>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">
          Preferences
        </p>
        <NewPreferencesSection initialPreferences={preferences} />
      </div>

      <DangerZoneSection />
    </div>
  )
}
