import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMappings } from '@/lib/actions/mappings'
import { getMappingsForRedesign } from '@/lib/actions/mappings-for-redesign'
import { getProject } from '@/lib/actions/projects'
import MappingContent from './MappingContent'
import type { MappingsResult } from '@/lib/actions/mappings'
import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'

interface Props {
  params: Promise<{ projectId: string }>
}

export default async function MappingPage({ params }: Props) {
  const { projectId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const projectResult = await supabase
    .from('projects')
    .select('id, name, use_mapping_redesign')
    .eq('id', projectId)
    .single()

  const project = projectResult.data
  if (!project) notFound()

  // Phase 3 dispatch: branch at the server-component level so we fetch
  // exactly one read path per render. Per design §8.2 the legacy
  // `getMappings` and the new `getMappingsForRedesign` are both
  // callable in parallel during Phase 3+4, but a given render picks one.
  const useRedesign = project.use_mapping_redesign === true

  const [legacyResult, redesignResult, fullProject] = await Promise.all([
    useRedesign
      ? Promise.resolve<MappingsResult | null>(null)
      : getMappings(projectId),
    useRedesign
      ? getMappingsForRedesign(projectId)
      : Promise.resolve<MappingsForRedesignResult | null>(null),
    getProject(projectId).catch(() => null),
  ])

  const projectInfo = fullProject ? {
    projectName: fullProject.name,
    sourceSystem: fullProject.datasets?.find((d) => d.role === 'source')?.name ?? null,
    targetSystem: fullProject.datasets?.find((d) => d.role === 'target')?.name ?? null,
    createdAt: fullProject.created_at,
    useMappingRedesign: fullProject.use_mapping_redesign,
    maintenanceMode: fullProject.maintenance_mode,
  } : undefined

  return (
    <MappingContent
      projectId={projectId}
      projectName={project.name}
      initialData={legacyResult}
      initialRedesignData={redesignResult}
      projectInfo={projectInfo}
    />
  )
}
