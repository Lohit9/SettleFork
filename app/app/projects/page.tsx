import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getProjectsWithStats } from '@/lib/actions/projects'
import { ProjectsList } from '@/components/app/ProjectsList'
import type { OrgRole } from '@/lib/types/organizations'

export default async function ProjectsPage() {
  const cookieStore = await cookies()
  const activeOrgId = cookieStore.get('settle-active-org')?.value
    ?? cookieStore.get('mine-active-org')?.value

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Resolve org role — don't depend solely on the cookie.
  // New users have no cookie yet; fall back to owner org then first org.
  let activeOrgRole: OrgRole = 'viewer'
  let resolvedOrgId = activeOrgId

  if (user) {
    const { data: memberships } = await supabase
      .from('org_memberships')
      .select('role, org_id')
      .eq('user_id', user.id)

    if (memberships && memberships.length > 0) {
      const membership = activeOrgId
        ? (memberships.find((m) => m.org_id === activeOrgId) ??
           memberships.find((m) => m.role === 'owner') ??
           memberships[0])
        : (memberships.find((m) => m.role === 'owner') ?? memberships[0])

      if (membership) {
        activeOrgRole = membership.role as OrgRole
        resolvedOrgId = membership.org_id
      }
    }
  }

  const projects = await getProjectsWithStats(resolvedOrgId)

  return <ProjectsList initialProjects={projects} activeOrgRole={activeOrgRole} />
}
