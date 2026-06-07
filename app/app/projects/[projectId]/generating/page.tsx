import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { GeneratingContent } from './GeneratingContent'

export default async function GeneratingPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const supabase = await createClient()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()

  if (!project) notFound()

  return (
    <GeneratingContent
      projectId={projectId}
      projectName={project.name}
    />
  )
}
