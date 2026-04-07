import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProjectSchema, getAllTablesForProject } from '@/lib/actions/data-overview'
import { PageHeader } from '@/components/app/PageHeader'
import DataOverviewContent from './DataOverviewContent'

interface Props {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ tab?: string; q?: string; mode?: string }>
}

export default async function DataOverviewPage({ params, searchParams }: Props) {
  const { projectId } = await params
  const { tab, q, mode } = await searchParams
  const supabase = await createClient()

  // Verify project ownership
  const { data: project } = await supabase
    .from('projects')
    .select('id, name, status, archived_at')
    .eq('id', projectId)
    .single()

  if (!project) notFound()

  const isArchived = project.status === 'archived'

  // Fetch all schema data and table list in parallel
  const [schema, tables] = await Promise.all([
    getProjectSchema(projectId),
    getAllTablesForProject(projectId),
  ])

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-gray-50">
      <PageHeader
        projectName={project.name}
        title="Data Overview"
        subtitle="Explore source and target data structures"
      />
      <DataOverviewContent
        projectId={projectId}
        schema={schema}
        tables={tables}
        isArchived={isArchived}
        archivedAt={(project as { archived_at?: string | null }).archived_at ?? null}
        initialTab={tab as 'schema' | 'preview' | 'query' | 'profiling' | undefined}
        initialQuery={q}
        initialQueryMode={mode as 'nl' | 'sql' | undefined}
      />
    </div>
  )
}
