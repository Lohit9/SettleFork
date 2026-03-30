import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getTransformData } from '@/lib/actions/transformations'
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
    .select('id, name')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) notFound()

  const transformData = await getTransformData(projectId)

  return (
    <TransformContent
      projectId={projectId}
      projectName={project.name}
      initialData={transformData}
    />
  )
}
