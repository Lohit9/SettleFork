import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMappings } from '@/lib/actions/mappings'
import { getProject } from '@/lib/actions/projects'
import MappingContent from './MappingContent'

interface Props {
  params: Promise<{ projectId: string }>
}

export default async function MappingPage({ params }: Props) {
  const { projectId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  const [projectResult, result] = await Promise.all([
    supabase.from('projects').select('id, name').eq('id', projectId).single(),
    getMappings(projectId),
  ])

  const project = projectResult.data
  if (!project) notFound()

  const fullProject = await getProject(projectId).catch(() => null)
  const projectInfo = fullProject ? {
    projectName: fullProject.name,
    sourceSystem: fullProject.datasets?.find((d) => d.role === 'source')?.name ?? null,
    targetSystem: fullProject.datasets?.find((d) => d.role === 'target')?.name ?? null,
    createdAt: fullProject.created_at,
  } : undefined

  return (
    <MappingContent
      projectId={projectId}
      projectName={project.name}
      initialData={result}
      projectInfo={projectInfo}
    />
  )
}
