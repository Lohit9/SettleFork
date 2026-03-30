import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMappings } from '@/lib/actions/mappings'
import MappingContent from './MappingContent'

interface Props {
  params: Promise<{ projectId: string }>
}

export default async function MappingPage({ params }: Props) {
  const { projectId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) notFound()

  const result = await getMappings(projectId)

  return (
    <MappingContent
      projectId={projectId}
      projectName={project.name}
      initialData={result}
    />
  )
}
