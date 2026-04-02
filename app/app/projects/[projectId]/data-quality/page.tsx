import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getQualityIssues, getFixHistory } from '@/lib/actions/quality-fixes'
import { getValidationRules } from '@/lib/actions/validation-rules'
import { computeReadinessScore } from '@/lib/quality/readiness-score'
import { getResolvedSourceFieldIds } from '@/lib/quality/resolved-by-transform'
import { supabaseAdmin } from '@/lib/supabase/admin'
import DataQualityContent from './DataQualityContent'

interface PageProps {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{
    tableId?: string
    fieldId?: string
    severity?: string
    status?: string
    stage?: string
  }>
}

export default async function DataQualityPage({ params, searchParams }: PageProps) {
  const { projectId } = await params
  const sp = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()

  // Parallel data fetch — fix history fetched once here to avoid N+1 per IssueCard
  const [{ issues, hasMappings }, validationRules, readiness, tablesData, initialFixHistory, resolvedSourceFieldIds, projectResult] = await Promise.all([
    getQualityIssues(projectId),
    getValidationRules(projectId),
    computeReadinessScore(projectId),
    // Fetch all tables with their fields for the add-rule modal
    supabaseAdmin
      .from('datasets')
      .select('id, role, name, tables(id, name, fields(id, name, data_type, inferred_type))')
      .eq('project_id', projectId),
    getFixHistory(projectId),
    // Source field IDs whose issues are resolved by an approved transform
    getResolvedSourceFieldIds(projectId).catch(() => [] as string[]),
    supabase.from('projects').select('name, status').eq('id', projectId).single(),
  ])

  const allDatasets = (tablesData.data ?? []) as Array<{
    id: string
    role: string
    name: string
    tables: Array<{
      id: string
      name: string
      fields: Array<{ id: string; name: string; data_type: string; inferred_type: string | null }>
    }>
  }>

  const isArchived = projectResult.data?.status === 'archived'

  return (
    <DataQualityContent
      projectId={projectId}
      projectName={projectResult.data?.name ?? ''}
      initialIssues={issues}
      initialReadiness={readiness}
      initialRules={validationRules}
      hasMappings={hasMappings}
      allDatasets={allDatasets}
      initialFixHistory={initialFixHistory}
      resolvedSourceFieldIds={resolvedSourceFieldIds}
      initialFilterTableId={sp.tableId}
      initialFilterFieldId={sp.fieldId}
      initialFilterSeverity={sp.severity}
      initialFilterStatus={sp.status}
      initialFilterStage={sp.stage}
      isArchived={isArchived}
    />
  )
}
