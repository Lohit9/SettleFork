import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import {
  getTransformData,
  projectHasCrossTableMappings,
} from '@/lib/actions/transformations'
import { getProject } from '@/lib/actions/projects'
import TransformContent from './TransformContent'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function TransformPage({ params }: PageProps) {
  const { projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, status')
    .eq('id', projectId)
    .single()
  if (!project) notFound()

  const [transformData, fullProject, hasCrossTableMappings] = await Promise.all([
    getTransformData(projectId),
    getProject(projectId).catch(() => null),
    // Phase 4a-3: detect cross-table TFMs at the page boundary so the
    // redesign Transform placeholder can surface the apply limitation.
    // Falls back to `false` on any error — the note is informational only.
    projectHasCrossTableMappings(projectId).catch(() => false),
  ])
  const isArchived = project.status === 'archived'

  const projectInfo = fullProject ? {
    projectName: fullProject.name,
    sourceSystem: fullProject.datasets?.find((d) => d.role === 'source')?.name ?? null,
    targetSystem: fullProject.datasets?.find((d) => d.role === 'target')?.name ?? null,
    createdAt: fullProject.created_at,
    useMappingRedesign: fullProject.use_mapping_redesign,
    maintenanceMode: fullProject.maintenance_mode,
  } : undefined

  return (
    <TransformContent
      projectId={projectId}
      projectName={project.name}
      initialData={transformData}
      isArchived={isArchived}
      projectInfo={projectInfo}
      hasCrossTableMappings={hasCrossTableMappings}
    />
  )
}
