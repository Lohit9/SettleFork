import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getOutputsPageData } from '@/lib/actions/outputs'
import OutputsContent from './OutputsContent'
import type { SqlDialect } from '@/lib/types/database'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function OutputsPage({ params }: PageProps) {
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

  const pageData = await getOutputsPageData(projectId)
  const isArchived = project.status === 'archived'

  // Detect target DB type for smart dialect default
  let targetDbType: SqlDialect = 'postgresql'
  if (pageData.targetDataset) {
    const { data: conn } = await supabase
      .from('db_connections')
      .select('db_type')
      .eq('dataset_id', pageData.targetDataset.id)
      .maybeSingle()
    if (conn?.db_type === 'mssql') targetDbType = 'tsql'
    else if (conn?.db_type === 'mysql') targetDbType = 'mysql'
  }

  return (
    <OutputsContent
      projectId={projectId}
      projectName={project.name}
      initialData={pageData}
      isArchived={isArchived}
      targetDbType={targetDbType}
    />
  )
}
