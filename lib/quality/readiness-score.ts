'use server'

/**
 * Migration Readiness Score Computation
 *
 * Score = 100 - blocking_penalty - warning_penalty - unmapped_penalty
 * Blocking issues heavily penalize (max 60 pts), warnings moderately (max 20 pts),
 * unmapped required target fields penalize up to 20 pts.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import type { ReadinessScore, QualityIssue } from '@/lib/types/database'

export async function computeReadinessScore(projectId: string): Promise<ReadinessScore> {
  // Count open issues by severity
  const { data: openIssues } = await supabaseAdmin
    .from('quality_issues')
    .select('severity, affected_records, title, description, id, stage, field_id, table_id, status, created_at, ai_suggested_fix, generated_sql, ai_fix_options, downstream_impact, affected_rows_sample, detection_source, validation_rule_id')
    .eq('project_id', projectId)
    .eq('status', 'open')
    .order('severity', { ascending: true }) // blocking first
    .order('affected_records', { ascending: false })

  const issues = (openIssues as QualityIssue[]) ?? []
  const blockingCount = issues.filter((i) => i.severity === 'blocking').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length

  // Count total fields checked (all fields in the project)
  const { data: projectDatasets } = await supabaseAdmin
    .from('datasets')
    .select('id')
    .eq('project_id', projectId)

  let totalFields = 0
  if (projectDatasets && projectDatasets.length > 0) {
    const datasetIds = projectDatasets.map((d) => d.id)
    const { data: tables } = await supabaseAdmin
      .from('tables')
      .select('id')
      .in('dataset_id', datasetIds)

    if (tables && tables.length > 0) {
      const tableIds = tables.map((t) => t.id)
      const { count } = await supabaseAdmin
        .from('fields')
        .select('*', { count: 'exact', head: true })
        .in('table_id', tableIds)
      totalFields = count ?? 0
    }
  }

  // Fields with zero open issues
  const fieldsWithIssues = new Set(issues.filter((i) => i.field_id).map((i) => i.field_id))
  const readyFieldCount = Math.max(0, totalFields - fieldsWithIssues.size)

  // Count unmapped required target fields (non-nullable with no field_mapping)
  const { data: targetDatasets } = await supabaseAdmin
    .from('datasets')
    .select('id')
    .eq('project_id', projectId)
    .eq('role', 'target')

  let unmappedRequiredCount = 0
  let totalRequiredCount = 1 // avoid division by zero

  if (targetDatasets && targetDatasets.length > 0) {
    const targetDatasetIds = targetDatasets.map((d) => d.id)
    const { data: targetTables } = await supabaseAdmin
      .from('tables')
      .select('id')
      .in('dataset_id', targetDatasetIds)

    if (targetTables && targetTables.length > 0) {
      const targetTableIds = targetTables.map((t) => t.id)
      const { data: requiredFields } = await supabaseAdmin
        .from('fields')
        .select('id')
        .in('table_id', targetTableIds)
        .eq('is_nullable', false)

      if (requiredFields) {
        totalRequiredCount = Math.max(requiredFields.length, 1)

        for (const rf of requiredFields) {
          const { count } = await supabaseAdmin
            .from('field_mappings')
            .select('*', { count: 'exact', head: true })
            .eq('target_field_id', rf.id)

          if ((count ?? 0) === 0) unmappedRequiredCount++
        }
      }
    }
  }

  // Compute score
  const safeTotalFields = Math.max(totalFields, 1)
  const blockingPenalty = Math.min((blockingCount / safeTotalFields) * 60, 60)
  const warningPenalty = Math.min((warningCount / safeTotalFields) * 20, 20)
  const unmappedPenalty = Math.min((unmappedRequiredCount / totalRequiredCount) * 20, 20)
  const score = Math.max(0, Math.round(100 - blockingPenalty - warningPenalty - unmappedPenalty))

  let status: ReadinessScore['status'] = 'not_ready'
  if (score >= 80) status = 'ready'
  else if (score >= 50) status = 'at_risk'

  // Top 3-5 issues: blocking first, then by affected_records desc
  const topIssues = issues
    .sort((a, b) => {
      if (a.severity === 'blocking' && b.severity !== 'blocking') return -1
      if (b.severity === 'blocking' && a.severity !== 'blocking') return 1
      return (b.affected_records ?? 0) - (a.affected_records ?? 0)
    })
    .slice(0, 5)

  return {
    score,
    status,
    blocking_count: blockingCount,
    warning_count: warningCount,
    ready_field_count: readyFieldCount,
    total_fields_checked: totalFields,
    unmapped_required_count: unmappedRequiredCount,
    top_issues: topIssues,
  }
}
