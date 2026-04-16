import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getDatasetsWithTables } from '@/lib/actions/datasets'
import { getSchemaDocuments, getBusinessContextDocs } from '@/lib/actions/schema-documents'
import { ControlPlaneContent } from './project/ControlPlaneContent'

export default async function ControlPlanePage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const supabase = await createClient()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, created_at, datasets(*)')
    .eq('id', projectId)
    .single()

  if (!project) notFound()

  const projectInfo = {
    projectName: project.name,
    sourceSystem:
      (project.datasets as { role: string; name: string }[] ?? [])
        .find((d) => d.role === 'source')?.name ?? null,
    targetSystem:
      (project.datasets as { role: string; name: string }[] ?? [])
        .find((d) => d.role === 'target')?.name ?? null,
    createdAt: project.created_at,
  }

  const [sourceDatasets, targetDatasets] = await Promise.all([
    getDatasetsWithTables(projectId, 'source'),
    getDatasetsWithTables(projectId, 'target'),
  ])

  const primarySourceDatasetId = sourceDatasets[0]?.id ?? null
  const primaryTargetDatasetId = targetDatasets[0]?.id ?? null

  const [sourceDocs, targetDocs, contextDocs] = await Promise.all([
    primarySourceDatasetId ? getSchemaDocuments(primarySourceDatasetId) : Promise.resolve([]),
    primaryTargetDatasetId ? getSchemaDocuments(primaryTargetDatasetId) : Promise.resolve([]),
    getBusinessContextDocs(projectId),
  ])

  return (
    <ControlPlaneContent
      projectId={projectId}
      projectName={project.name}
      sourceDatasets={sourceDatasets}
      targetDatasets={targetDatasets}
      initialSourceDocs={sourceDocs}
      initialTargetDocs={targetDocs}
      initialContextDocs={contextDocs}
      primarySourceDatasetId={primarySourceDatasetId}
      primaryTargetDatasetId={primaryTargetDatasetId}
      projectInfo={projectInfo}
    />
  )
}
