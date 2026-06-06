import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMappings } from '@/lib/actions/mappings'
import { getMappingsForRedesign } from '@/lib/actions/mappings-for-redesign'
import { getProjectStats } from '@/lib/quality/project-stats'
import MappingContent from './MappingContent'
import MappingRedesignContent from './redesign/MappingContent'

export const maxDuration = 800

interface Props {
  params: Promise<{ projectId: string }>
}

// Server-side dispatch on `projects.use_mapping_redesign`: picks exactly
// one Content component to render and fetches only the data feed that
// component needs.
export default async function MappingPage({ params }: Props) {
  const { projectId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, use_mapping_redesign')
    .eq('id', projectId)
    .single()

  if (!project) notFound()

  const useRedesign = project.use_mapping_redesign === true

  if (useRedesign) {
    // PR-3 (feat/inner-page-stats-redesign): fetch the canonical
    // ProjectStats alongside the grid data feed. Option A from PR-3
    // Stop 1 — page-level RSC calls the helper directly (already public
    // from PR-1, no `lib/` touches), threads `projectStats` through
    // Content to the new `MappingProjectStatsRow` rendered above the
    // existing strip. The grid result stays scoped to grid concerns;
    // project-wide stats live at the page tier.
    const [initialRedesignData, projectStatsByProject] = await Promise.all([
      getMappingsForRedesign(projectId),
      getProjectStats([projectId], supabase),
    ])
    const projectStats = projectStatsByProject.get(projectId) ?? null

    // Source/target system names for the header breadcrumb (Configure | <project>
    // — <source> → <target>), matching the Settle MVP design.
    const { data: datasets } = await supabase
      .from('datasets')
      .select('name, role')
      .eq('project_id', projectId)
    const sourceSystemName = datasets?.find((d) => d.role === 'source')?.name ?? null
    const targetSystemName = datasets?.find((d) => d.role === 'target')?.name ?? null

    return (
      <MappingRedesignContent
        projectId={projectId}
        projectName={project.name}
        initialRedesignData={initialRedesignData}
        projectStats={projectStats}
        sourceSystemName={sourceSystemName}
        targetSystemName={targetSystemName}
      />
    )
  }

  const initialData = await getMappings(projectId)
  return (
    <MappingContent
      projectId={projectId}
      projectName={project.name}
      initialData={initialData}
    />
  )
}
