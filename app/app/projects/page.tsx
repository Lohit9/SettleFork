import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { getProjectsWithStats } from '@/lib/actions/projects'
import { ProjectsList } from '@/components/app/ProjectsList'
import type { OrgRole } from '@/lib/types/organizations'

export default async function ProjectsPage() {
  const cookieStore = await cookies()
  const activeOrgId = cookieStore.get('mine-active-org')?.value

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let activeOrgRole: OrgRole = 'viewer'
  if (user && activeOrgId) {
    const { data: membership } = await supabase
      .from('org_memberships')
      .select('role')
      .eq('org_id', activeOrgId)
      .eq('user_id', user.id)
      .single()
    if (membership?.role) activeOrgRole = membership.role as OrgRole
  }

  const projects = await getProjectsWithStats(activeOrgId)

  return <ProjectsList initialProjects={projects} activeOrgRole={activeOrgRole} />
}
