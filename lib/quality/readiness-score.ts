'use server'

/**
 * Migration Readiness Score — DB-fetching wrapper.
 *
 * The formula itself lives in `lib/quality/readiness-formula.ts` and is shared
 * with `getOutputsPageData`, `generateReadinessReport`, and the migration
 * runbook so every surface shows the same score.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import type { ReadinessScore, QualityIssue } from '@/lib/types/database'
import { calculateReadinessScore } from '@/lib/quality/readiness-formula'
import { fieldNeedsTransform } from '@/lib/utils/transform-helpers'

export async function computeReadinessScore(projectId: string): Promise<ReadinessScore> {
  // ── Round 1: parallel fetch — everything driven by projectId alone ──────────
  const [
    { data: datasets },
    { data: qualityIssueRows },
    { data: rawTableMappings },
    { data: acknowledgmentRows },
  ] = await Promise.all([
    supabaseAdmin.from('datasets').select('id, role').eq('project_id', projectId),
    supabaseAdmin
      .from('quality_issues')
      .select(
        'severity, affected_records, title, description, id, stage, field_id, table_id, status, created_at, ai_suggested_fix, generated_sql, ai_fix_options, downstream_impact, affected_rows_sample, detection_source, validation_rule_id, project_id, issue_kind'
      )
      .eq('project_id', projectId),
    supabaseAdmin
      .from('table_mappings')
      .select('id, status')
      .eq('project_id', projectId)
      .neq('status', 'rejected'),
    supabaseAdmin.from('field_acknowledgments').select('field_id').eq('project_id', projectId),
  ])

  const sourceDatasetIds = (datasets ?? []).filter((d) => d.role === 'source').map((d) => d.id)
  const targetDatasetIds = (datasets ?? []).filter((d) => d.role === 'target').map((d) => d.id)
  const allDatasetIds = [...sourceDatasetIds, ...targetDatasetIds]
  const nonRejectedTMIds = (rawTableMappings ?? []).map((tm) => tm.id)

  // ── Round 2: tables for both datasets ──────────────────────────────────────
  const { data: allTables } = allDatasetIds.length > 0
    ? await supabaseAdmin.from('tables').select('id, dataset_id').in('dataset_id', allDatasetIds)
    : { data: [] as { id: string; dataset_id: string }[] }

  const sourceTables = (allTables ?? []).filter((t) => sourceDatasetIds.includes(t.dataset_id))
  const targetTables = (allTables ?? []).filter((t) => targetDatasetIds.includes(t.dataset_id))
  const sourceTableIds = sourceTables.map((t) => t.id)
  const targetTableIds = targetTables.map((t) => t.id)

  // ── Round 3: fields, field mappings ─────────────────────────────────────────
  const [{ data: sourceFieldRows }, { data: targetFieldRows }, { data: rawFieldMappings }] =
    await Promise.all([
      sourceTableIds.length > 0
        ? supabaseAdmin.from('fields').select('id, name, data_type').in('table_id', sourceTableIds)
        : Promise.resolve({ data: [] as { id: string; name: string; data_type: string }[] }),
      targetTableIds.length > 0
        ? supabaseAdmin.from('fields').select('id, name, data_type').in('table_id', targetTableIds)
        : Promise.resolve({ data: [] as { id: string; name: string; data_type: string }[] }),
      nonRejectedTMIds.length > 0
        ? supabaseAdmin
            .from('field_mappings')
            .select(
              'id, status, source_field_id, target_field_id, confidence, is_contributing, needs_transformation, type_compatibility'
            )
            .in('table_mapping_id', nonRejectedTMIds)
            .neq('status', 'rejected')
        : Promise.resolve({ data: [] as Array<{
            id: string
            status: string
            source_field_id: string | null
            target_field_id: string
            confidence: number | null
            is_contributing: boolean
            needs_transformation: boolean | null
            type_compatibility: string | null
          }> }),
    ])

  const totalFields = (sourceFieldRows ?? []).length
  const allFMIds = (rawFieldMappings ?? []).map((fm) => fm.id)

  // ── Round 4: transformations + per-TM staging probes in parallel ───────────
  const [{ data: transformRows }, stagingCountResults] = await Promise.all([
    allFMIds.length > 0
      ? supabaseAdmin.from('transformations').select('field_mapping_id, status').in('field_mapping_id', allFMIds)
      : Promise.resolve({ data: [] as { field_mapping_id: string; status: string }[] }),
    nonRejectedTMIds.length > 0
      ? Promise.all(
          nonRejectedTMIds.map((tmId) =>
            supabaseAdmin
              .from('staged_data_rows')
              .select('id', { count: 'exact', head: true })
              .eq('table_mapping_id', tmId)
          )
        )
      : Promise.resolve([] as Array<{ count: number | null }>),
  ])

  // ── Mapping stats — mirrors getOutputsPageData + MappingContent header ─────
  const primaryFMs = (rawFieldMappings ?? []).filter(
    (fm) => !fm.is_contributing && fm.status !== 'rejected'
  )
  const approvedPrimaryFMs = primaryFMs.filter((fm) => fm.status === 'approved')

  const mappedSourceIds = new Set<string>(
    primaryFMs.filter((fm) => fm.source_field_id).map((fm) => fm.source_field_id as string)
  )
  for (const fm of rawFieldMappings ?? []) {
    if (fm.is_contributing && fm.status !== 'rejected' && fm.source_field_id) {
      mappedSourceIds.add(fm.source_field_id)
    }
  }
  const primaryMappedTargetIds = new Set(primaryFMs.map((fm) => fm.target_field_id))
  const acknowledgedIds = new Set((acknowledgmentRows ?? []).map((a) => a.field_id))

  let unmappedSourceCount = 0
  let unmappedTargetCount = 0
  let acknowledgedCount = 0
  for (const f of sourceFieldRows ?? []) {
    if (!mappedSourceIds.has(f.id)) {
      if (acknowledgedIds.has(f.id)) acknowledgedCount++
      else unmappedSourceCount++
    }
  }
  for (const f of targetFieldRows ?? []) {
    if (!primaryMappedTargetIds.has(f.id)) {
      if (acknowledgedIds.has(f.id)) acknowledgedCount++
      else unmappedTargetCount++
    }
  }
  const mappingTotal =
    primaryFMs.length + unmappedSourceCount + unmappedTargetCount + acknowledgedCount
  const mappingApproved = approvedPrimaryFMs.length + acknowledgedCount

  // ── Transform scope — mirrors getOutputsPageData heuristic ─────────────────
  const allTransforms = transformRows ?? []
  const fmIdsWithTransforms = new Set(allTransforms.map((t) => t.field_mapping_id))
  const transformByFmId = new Map(allTransforms.map((t) => [t.field_mapping_id, t]))

  const sourceFieldById = new Map((sourceFieldRows ?? []).map((f) => [f.id, f]))
  const targetFieldById = new Map((targetFieldRows ?? []).map((f) => [f.id, f]))

  const scoredFieldMappings = (rawFieldMappings ?? [])
    .filter((fm) => !fm.is_contributing)
    .map((fm) => {
      const isValueAssignment = !fm.source_field_id
      const srcField = fm.source_field_id ? sourceFieldById.get(fm.source_field_id) : null
      const tgtField = fm.target_field_id ? targetFieldById.get(fm.target_field_id) : null
      const hasTransformation = fmIdsWithTransforms.has(fm.id)

      const needsTransform = isValueAssignment
        ? true
        : fieldNeedsTransform({
            typeCompatibility: fm.type_compatibility ?? '',
            confidence: fm.confidence ?? 0,
            sourceDataType: srcField?.data_type ?? '',
            targetDataType: tgtField?.data_type ?? '',
            sourceFieldName: srcField?.name ?? '',
            targetFieldName: tgtField?.name ?? '',
            hasTransformation,
            needsTransformation: fm.needs_transformation ?? null,
          })

      return { id: fm.id, needsTransform }
    })

  const fieldsInScope = scoredFieldMappings.filter((fm) => fm.needsTransform)
  const transformScope = fieldsInScope.length
  const transformApplied = fieldsInScope.filter(
    (fm) => transformByFmId.get(fm.id)?.status === 'applied'
  ).length

  // ── Quality issues — in-flight only, mirrors Migration Center ──────────────
  const issues = (qualityIssueRows ?? []) as QualityIssue[]
  const openInFlight = issues.filter((q) => q.status === 'open' && q.stage === 'in_flight')
  const openBlocking = openInFlight.filter((q) => q.severity === 'blocking').length
  const openWarnings = openInFlight.filter((q) => q.severity === 'warning').length

  // ── Staging ────────────────────────────────────────────────────────────────
  const stagedTables = stagingCountResults.filter((r) => (r.count ?? 0) > 0).length
  const totalTables = targetTables.length

  // ── Compute the shared score ───────────────────────────────────────────────
  const readinessResult = calculateReadinessScore({
    mappingApproved,
    mappingTotal,
    transformApplied,
    transformScope,
    openBlocking,
    openWarnings,
    totalFields,
    stagedTables,
    totalTables,
  })

  // ── Legacy "top issues" and field-level rollups retained for the wrapper ──
  const fieldsWithIssues = new Set(
    issues.filter((i) => i.status === 'open' && i.field_id).map((i) => i.field_id)
  )
  const readyFieldCount = Math.max(0, totalFields - fieldsWithIssues.size)

  // Count unmapped NOT NULL + no-default target fields for legacy callers.
  const { data: requiredTargetFields } = targetTableIds.length > 0
    ? await supabaseAdmin
        .from('fields')
        .select('id')
        .in('table_id', targetTableIds)
        .eq('is_nullable', false)
        .is('default_value', null)
    : { data: [] as { id: string }[] }

  const mappedTargetFieldIdSet = new Set(
    (rawFieldMappings ?? [])
      .filter((fm) => fm.status === 'approved' && fm.target_field_id)
      .map((fm) => fm.target_field_id)
  )
  const unmappedRequiredCount = (requiredTargetFields ?? []).filter(
    (f) => !mappedTargetFieldIdSet.has(f.id)
  ).length

  const topIssues = issues
    .filter((i) => i.status === 'open')
    .sort((a, b) => {
      if (a.severity === 'blocking' && b.severity !== 'blocking') return -1
      if (b.severity === 'blocking' && a.severity !== 'blocking') return 1
      return (b.affected_records ?? 0) - (a.affected_records ?? 0)
    })
    .slice(0, 5)

  return {
    score: readinessResult.score,
    status: readinessResult.status,
    blocking_count: openBlocking,
    warning_count: openWarnings,
    ready_field_count: readyFieldCount,
    total_fields_checked: totalFields,
    unmapped_required_count: unmappedRequiredCount,
    top_issues: topIssues,
    components: readinessResult.components,
  }
}
