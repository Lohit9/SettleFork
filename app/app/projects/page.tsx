import { cookies } from 'next/headers'
import { getProjectsWithStats } from '@/lib/actions/projects'
import SidebarShell from '@/components/app/SidebarShell'
import { ProjectsList } from '@/components/app/ProjectsList'

export default async function ProjectsPage() {
  const cookieStore = await cookies()
  const activeOrgId = cookieStore.get('mine-active-org')?.value
  const projects = await getProjectsWithStats(activeOrgId)

  return (
    <SidebarShell>
      <ProjectsList initialProjects={projects} />
    </SidebarShell>
  )
}
