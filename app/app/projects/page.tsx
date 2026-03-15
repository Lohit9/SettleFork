import { getProjects } from '@/lib/actions/projects'
import SidebarShell from '@/components/app/SidebarShell'
import { ProjectsList } from '@/components/app/ProjectsList'

export default async function ProjectsPage() {
  const projects = await getProjects()

  return (
    <SidebarShell>
      <ProjectsList initialProjects={projects} />
    </SidebarShell>
  )
}
