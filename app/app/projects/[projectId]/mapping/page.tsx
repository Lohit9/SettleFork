import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMappings } from '@/lib/actions/mappings'
import { getMappingsForRedesign } from '@/lib/actions/mappings-for-redesign'
import MappingContent from './MappingContent'
import MappingRedesignContent from './redesign/MappingContent'

interface Props {
  params: Promise<{ projectId: string }>
}

// Phase 3 Gap 1 / PR 2a: the `use_mapping_redesign` dispatch lives here
// at the server boundary. We pick exactly one Content component to render
// based on `projects.use_mapping_redesign`, and only fetch the data feed
// the chosen component needs. Pre-PR 2a this branch lived inside the
// legacy `MappingContent` default export and consumed `projectInfo`; the
// dispatch was lifted to the server so `projectInfo` could be retired
// alongside the (i)→gear ripple in the next commit.
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
    const initialRedesignData = await getMappingsForRedesign(projectId)
    return (
      <MappingRedesignContent
        projectId={projectId}
        projectName={project.name}
        initialRedesignData={initialRedesignData}
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
