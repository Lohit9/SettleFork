'use server'

/**
 * Migration Readiness Score — DB-fetching wrapper (Prompt 3c rewrite
 * against the mapping-redesign data model, migrations 074 + 075).
 *
 * The scoring formula itself lives in `lib/quality/readiness-formula.ts` and
 * is shared with `getOutputsPageData`, `generateReadinessReport`, and the
 * migration runbook so every surface shows the same score. THIS file is the
 * data-gathering wrapper: it loads the TFM / mapping-source / transformation
 * rows, computes the five formula inputs (mappingApproved, mappingTotal,
 * transformApplied, transformScope, stagedTables) and the two issue counts
 * (openBlocking, openWarnings), then hands the bundle to
 * `calculateReadinessScore`.
 *
 * New-model translation of the legacy concepts
 * --------------------------------------------
 *   Legacy `field_mappings` (is_contributing=false, status!='rejected')
 *   → `primaryTfms`: non-rejected target_field_mappings, excluding bare
 *     acknowledgments (is_acknowledged=true AND combination_type IS NULL).
 *
 *   Legacy `field_mappings.source_field_id` (every non-rejected row)
 *   → union of `mapping_sources.source_field_id` for every MS row whose
 *     parent TFM is non-rejected (regardless of ordinal). This matches the
 *     legacy "primary + contributor FMs both count as mapping the source"
 *     contract.
 *
 *   Legacy `field_acknowledgments` table (both sides)
 *   → `source_field_acknowledgments` for source-side acks PLUS bare-ack
 *     TFMs (is_acknowledged=true, combination_type IS NULL) for target-side
 *     acks. Migration 074 moved target-side acks into a TFM row.
 *
 *   Legacy `transformations.field_mapping_id`
 *   → `transformations.target_field_mapping_id`. The invariant that at
 *     most one transformation exists per TFM is enforced at the schema
 *     level (see `lib/types/mapping-redesign.ts`).
 *
 * Rejected TFMs are excluded from every count (they represent work the user
 * has explicitly dismissed). Rejected MS rows inside non-rejected TFMs are
 * loaded but ordinal semantics put the primary at ordinal=0, so the
 * `fieldNeedsTransform` heuristic is evaluated against the primary alone.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import type { ReadinessScore, QualityIssue } from '@/lib/types/database'
import { calculateReadinessScore } from '@/lib/quality/readiness-formula'
import { computeProjectStats } from '@/lib/quality/stat-formulas'
import type { MappingSourceRow, TargetFieldMappingRow } from '@/lib/types/mapping-redesign'

export async function computeReadinessScore(projectId: string): Promise<ReadinessScore> {
  // ── Round 1: parallel fetch — everything driven by projectId alone ──────
  const [
    { data: datasets },
    { data: qualityIssueRows },
    { data: rawTableMappings },
    { data: sourceAckRows },
    { data: tfmRows },
    { data: coverageRows },
  ] = await Promise.all([
    supabaseAdmin.from('datasets').select('id, role').eq('project_id', projectId),
    supabaseAdmin
      .from('quality_issues')
      .select(
        'severity, affected_records, title, description, id, stage, field_id, table_id, status, created_at, ai_suggested_fix, generated_sql, ai_fix_options, downstream_impact, affected_rows_sample, detection_source, validation_rule_id, project_id, issue_kind',
      )
      .eq('project_id', projectId),
    supabaseAdmin
      .from('table_mappings')
      .select('id, status')
      .eq('project_id', projectId)
      .neq('status', 'rejected'),
    supabaseAdmin
      .from('source_field_acknowledgments')
      .select('source_field_id')
      .eq('project_id', projectId),
    supabaseAdmin
      .from('target_field_mappings')
      .select(
        'id, project_id, target_field_id, confidence, status, ai_reasoning, is_acknowledged, acknowledgment_reason, combination_type, combination_sql, needs_transformation, va_dismissed, dismissal_reason, created_at, updated_at',
      )
      .eq('project_id', projectId),
    // INF-57 — coverage rows for the canonical no-source UNION semantics
    // in computeProjectStats. Without this, readiness-score under-counts
    // mappingApproved on projects with coverage-approved+user fields that
    // have no paired bare-ack TFM (post-redesign-drawer-only acks).
    supabaseAdmin
      .from('target_field_coverage')
      .select('target_field_id, status, status_set_by')
      .eq('project_id', projectId),
  ])

  const sourceDatasetIds = (datasets ?? []).filter((d) => d.role === 'source').map((d) => d.id)
  const targetDatasetIds = (datasets ?? []).filter((d) => d.role === 'target').map((d) => d.id)
  const allDatasetIds = [...sourceDatasetIds, ...targetDatasetIds]
  const nonRejectedTMIds = (rawTableMappings ?? []).map((tm) => tm.id)

  // ── Round 2: tables for both datasets ──────────────────────────────────
  const { data: allTables } = allDatasetIds.length > 0
    ? await supabaseAdmin.from('tables').select('id, dataset_id').in('dataset_id', allDatasetIds)
    : { data: [] as { id: string; dataset_id: string }[] }

  const sourceTables = (allTables ?? []).filter((t) => sourceDatasetIds.includes(t.dataset_id))
  const targetTables = (allTables ?? []).filter((t) => targetDatasetIds.includes(t.dataset_id))
  const sourceTableIds = sourceTables.map((t) => t.id)
  const targetTableIds = targetTables.map((t) => t.id)

  // ── Round 3: fields + mapping_sources ───────────────────────────────────
  const tfms = (tfmRows ?? []) as TargetFieldMappingRow[]
  const tfmIdSet = new Set(tfms.map((t) => t.id))

  const [{ data: sourceFieldRows }, { data: targetFieldRows }, { data: msRows }] = await Promise.all([
    sourceTableIds.length > 0
      ? supabaseAdmin.from('fields').select('id, name, data_type').in('table_id', sourceTableIds)
      : Promise.resolve({ data: [] as { id: string; name: string; data_type: string }[] }),
    targetTableIds.length > 0
      ? supabaseAdmin.from('fields').select('id, name, data_type').in('table_id', targetTableIds)
      : Promise.resolve({ data: [] as { id: string; name: string; data_type: string }[] }),
    tfmIdSet.size > 0
      ? supabaseAdmin
          .from('mapping_sources')
          .select(
            'id, target_field_mapping_id, source_field_id, source_table_id, confidence, ai_reasoning, similar_fields_considered, type_compatibility, join_spec, ordinal, created_at',
          )
          .in('target_field_mapping_id', Array.from(tfmIdSet))
      : Promise.resolve({ data: [] as MappingSourceRow[] }),
  ])

  const totalFields = (sourceFieldRows ?? []).length
  const mappingSources = (msRows ?? []) as MappingSourceRow[]

  // ── Round 4: transformations + per-TM staging probes in parallel ───────
  const [{ data: transformRows }, stagingCountResults] = await Promise.all([
    tfmIdSet.size > 0
      ? supabaseAdmin
          .from('transformations')
          .select('target_field_mapping_id, status')
          .in('target_field_mapping_id', Array.from(tfmIdSet))
      : Promise.resolve({
          data: [] as { target_field_mapping_id: string; status: string }[],
        }),
    nonRejectedTMIds.length > 0
      ? Promise.all(
          nonRejectedTMIds.map((tmId) =>
            supabaseAdmin
              .from('staged_data_rows')
              .select('id', { count: 'exact', head: true })
              .eq('table_mapping_id', tmId),
          ),
        )
      : Promise.resolve([] as Array<{ count: number | null }>),
  ])

  // ── Mapping / transform / quality-issue stats ──────────────────────────
  //
  // Single source of truth: `computeProjectStats` (lib/quality/stat-formulas.ts).
  // That helper owns the formulas shared by `getOutputsPageDataCore`, this
  // readiness scorer, and (post Prompt B) the Projects Dashboard card.
  //
  // This wrapper uses the *naive* open-issue counts for the readiness
  // formula — not the resolution-suppressed ones the Migration Center card
  // uses — preserving the pre-extraction behavior exactly. The helper
  // exposes both flavors so each caller picks deliberately.
  const issues = (qualityIssueRows ?? []) as QualityIssue[]
  const stats = computeProjectStats({
    tfms,
    mappingSources,
    sourceFields: (sourceFieldRows ?? []).map((f) => ({ id: f.id, name: f.name, data_type: f.data_type })),
    targetFields: (targetFieldRows ?? []).map((f) => ({ id: f.id, name: f.name, data_type: f.data_type })),
    sourceAckFieldIds: (sourceAckRows ?? []).map((a) => a.source_field_id),
    transforms: (transformRows ?? []).map((t) => ({
      target_field_mapping_id: t.target_field_mapping_id,
      status: t.status,
    })),
    qualityIssues: issues,
    coverage: (coverageRows ?? []).map((c) => ({
      target_field_id: c.target_field_id,
      status: c.status,
      status_set_by: c.status_set_by,
    })),
  })

  const mappingApproved = stats.mappingApproved
  const mappingTotal = stats.mappingTotal
  const transformApplied = stats.transformApplied
  const transformScope = stats.transformScope
  const openBlocking = stats.openBlocking
  const openWarnings = stats.openWarnings

  // ── Staging ────────────────────────────────────────────────────────────
  const stagedTables = stagingCountResults.filter((r) => (r.count ?? 0) > 0).length
  const totalTables = targetTables.length

  // ── Compute the shared score ───────────────────────────────────────────
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

  // ── Legacy "top issues" and field-level rollups retained for the wrapper
  const fieldsWithIssues = new Set(
    issues.filter((i) => i.status === 'open' && i.field_id).map((i) => i.field_id),
  )
  const readyFieldCount = Math.max(0, totalFields - fieldsWithIssues.size)

  const { data: requiredTargetFields } = targetTableIds.length > 0
    ? await supabaseAdmin
        .from('fields')
        .select('id')
        .in('table_id', targetTableIds)
        .eq('is_nullable', false)
        .is('default_value', null)
    : { data: [] as { id: string }[] }

  // Legacy computed `mappedTargetFieldIdSet` from
  // `field_mappings.status='approved'`. New-model equivalent: approved TFMs'
  // target_field_id (bare acks excluded by `primaryTfms`; we include all
  // approved TFMs here to match the legacy predicate "any approved row
  // pointing at this target counts as mapped").
  //
  // Dismissed value assignments (migration 077) are also "addressed" — the
  // user explicitly marked the target field as not needing a value. They
  // should NOT inflate `unmapped_required_count` even if their TFM hasn't
  // been transitioned to `status='approved'` yet, so we union them in
  // alongside the approved-TFM set.
  const mappedTargetFieldIdSet = new Set(
    tfms
      .filter(
        (t) =>
          (t.status === 'approved' || t.va_dismissed === true) && !!t.target_field_id,
      )
      .map((t) => t.target_field_id),
  )
  const unmappedRequiredCount = (requiredTargetFields ?? []).filter(
    (f) => !mappedTargetFieldIdSet.has(f.id),
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
