import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
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
    <div className="px-8 py-6 max-w-3xl">
      <OrganizationSettingsContent
        org={org}
        orgRole={orgRole}
        currentUserId={user.id}
        multiOrg={multiOrg}
      />
    </div>
  )
}
