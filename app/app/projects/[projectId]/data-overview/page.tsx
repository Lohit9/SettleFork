import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProjectSchema, getAllTablesForProject } from '@/lib/actions/data-overview'
import DataOverviewContent from './DataOverviewContent'

interface Props {
  params: Promise<{ projectId: string }>
}

export default async function DataOverviewPage({ params }: Props) {
  const { projectId } = await params
  const supabase = await createClient()

  // Verify project ownership
  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()

  if (!project) notFound()

  // Fetch all schema data and table list in parallel
  const [schema, tables] = await Promise.all([
    getProjectSchema(projectId),
    getAllTablesForProject(projectId),
  ])

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-50">
      {/* Page header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Data Overview</h1>
        <p className="text-sm text-gray-500 mt-0.5">Explore source and target data structures</p>
      </div>

      <DataOverviewContent projectId={projectId} schema={schema} tables={tables} />
    </div>
  )
}
