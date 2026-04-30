import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMappings } from '@/lib/actions/mappings'
import { getMappingsForRedesign } from '@/lib/actions/mappings-for-redesign'
import MappingContent from './MappingContent'
import MappingRedesignContent from './redesign/MappingContent'

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
