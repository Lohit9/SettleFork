import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import OrganizationSettingsContent from './OrganizationSettingsContent'
import type { OrgRole } from '@/lib/types/organizations'

export default async function OrganizationSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const cookieStore = await cookies()
  const activeOrgId = cookieStore.get('settle-active-org')?.value
    ?? cookieStore.get('mine-active-org')?.value

  // Get all user memberships to resolve active org
  const { data: memberships } = await supabase
    .from('org_memberships')
    .select('org_id, role')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: true })

  if (!memberships || memberships.length === 0) redirect('/app/projects')

  const activeMembership =
    memberships.find((m) => m.org_id === activeOrgId) ??
    memberships.find((m) => m.role === 'owner') ??
    memberships[0]

  const orgRole = activeMembership.role as OrgRole

  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, slug, created_at, member_auto_grant_enabled')
    .eq('id', activeMembership.org_id)
    .single()

  if (!org) redirect('/app/projects')

  const multiOrg = memberships.length > 1

  return (
    <div className="flex-1 bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white">
        <div className="px-8 py-5 flex items-center justify-between">
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
        <div className="px-8 flex gap-6">
          <a
            href="/app/settings"
            className="pb-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent"
          >
            General
          </a>
          <a
            href="/app/settings/organization"
            className="pb-2.5 text-sm font-medium text-blue-600 border-b-2 border-blue-600"
          >
            Organization
          </a>
        </div>
      </div>

      <div className="px-8 py-6 max-w-3xl">
        <OrganizationSettingsContent
          org={org}
          orgRole={orgRole}
          currentUserId={user.id}
          multiOrg={multiOrg}
        />
      </div>
    </div>
  )
}
