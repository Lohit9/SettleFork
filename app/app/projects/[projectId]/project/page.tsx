import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getDatasetsWithTables } from '@/lib/actions/datasets'
import { getSchemaDocuments, getBusinessContextDocs } from '@/lib/actions/schema-documents'
import { ControlPlaneContent } from './ControlPlaneContent'
import type { DBConnectionInfo } from '@/lib/types/database'

export default async function ControlPlanePage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const supabase = await createClient()

  // Verify project ownership (RLS handles this, but we also want a 404 on missing)
  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()

  if (!project) notFound()

  // Fetch datasets + their tables (with field counts) for both roles
  const [sourceDatasets, targetDatasets] = await Promise.all([
    getDatasetsWithTables(projectId, 'source'),
    getDatasetsWithTables(projectId, 'target'),
  ])

  const primarySourceDatasetId = sourceDatasets[0]?.id ?? null
  const primaryTargetDatasetId = targetDatasets[0]?.id ?? null

  // Fetch DB connections for all datasets in this project — password_encrypted is NOT selected
  const allDatasetIds = [...sourceDatasets, ...targetDatasets].map((d) => d.id)
  const { data: rawConnections } = allDatasetIds.length > 0
    ? await supabase
        .from('db_connections')
        .select('id, dataset_id, db_type, host, port, database_name, username, ssl_mode, status, last_connected_at')
        .in('dataset_id', allDatasetIds)
    : { data: [] }

  const initialConnections: Record<string, DBConnectionInfo> = {}
  for (const conn of rawConnections ?? []) {
    initialConnections[conn.dataset_id] = {
      id: conn.id,
      db_type: conn.db_type,
      host: conn.host,
      port: conn.port,
      database_name: conn.database_name,
      username: conn.username,
      ssl_mode: conn.ssl_mode,
      status: conn.status,
      last_connected_at: conn.last_connected_at,
    }
  }

  // Prefetch schema documents and business context docs
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
      initialConnections={initialConnections}
    />
  )
}
