import { getProjectsWithStats } from '@/lib/actions/projects'
import SidebarShell from '@/components/app/SidebarShell'
import { ProjectsList } from '@/components/app/ProjectsList'

export default async function ProjectsPage() {
  const projects = await getProjectsWithStats()

  return (
    <SidebarShell>
      <ProjectsList initialProjects={projects} />
    </SidebarShell>
  )
}
