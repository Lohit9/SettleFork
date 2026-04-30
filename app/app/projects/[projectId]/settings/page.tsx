import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProject } from '@/lib/actions/projects'
import {
  checkProjectPermission,
  requireProjectPermission,
} from '@/lib/actions/role-resolution'
import {
  getProjectMembers,
  getOrgMembersAvailableForProject,
} from '@/lib/actions/project-members'
import ProjectSettingsContent from './ProjectSettingsContent'

interface Props {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ tab?: string }>
}

// Project Settings server entry. Auth + viewer-permission gate, parallel
// fetch, then hand off to the client tab shell. The picker pool is fetched
// only when the caller is also an admin — viewers/editors get no picker.
export default async function ProjectSettingsPage({ params, searchParams }: Props) {
  const { projectId } = await params
  const { tab: tabParam } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect(`/login?returnTo=/app/projects/${projectId}/settings`)
  }

  const gate = await requireProjectPermission(projectId, 'viewer')
  if (!gate.allowed) notFound()

  const project = await getProject(projectId).catch(() => null)
  if (!project) notFound()

  const isAdmin = await checkProjectPermission(projectId, 'admin')

  const [{ members }, available] = await Promise.all([
    getProjectMembers(projectId),
    isAdmin
      ? getOrgMembersAvailableForProject(projectId, project.org_id)
      : Promise.resolve({ members: [] as Awaited<
          ReturnType<typeof getOrgMembersAvailableForProject>
        >['members'] }),
  ])

  const initialTab: 'members' | 'info' = tabParam === 'info' ? 'info' : 'members'

  // Surface the project's source/target dataset names for InfoTab. Mirrors
  // the field set the (deleted) ProjectInfoPopover used.
  const sourceSystem =
    project.datasets?.find((d) => d.role === 'source')?.name ?? null
  const targetSystem =
    project.datasets?.find((d) => d.role === 'target')?.name ?? null

  return (
    <ProjectSettingsContent
      projectId={projectId}
      projectName={project.name}
      info={{
        projectName: project.name,
        sourceSystem,
        targetSystem,
        createdAt: project.created_at,
      }}
      initialMembers={members}
      initialAvailableOrgMembers={available.members}
      currentUserId={user.id}
      isAdmin={isAdmin}
      initialTab={initialTab}
    />
  )
}
