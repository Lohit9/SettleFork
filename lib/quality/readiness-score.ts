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
import { fieldNeedsTransform } from '@/lib/utils/transform-helpers'
import type { MappingSourceRow, TargetFieldMappingRow } from '@/lib/types/mapping-redesign'

export async function computeReadinessScore(projectId: string): Promise<ReadinessScore> {
  // ── Round 1: parallel fetch — everything driven by projectId alone ──────
  const [
    { data: datasets },
    { data: qualityIssueRows },
    { data: rawTableMappings },
    { data: sourceAckRows },
    { data: tfmRows },
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
        'id, project_id, target_field_id, confidence, status, ai_reasoning, is_acknowledged, acknowledgment_reason, combination_type, combination_sql, needs_transformation, created_at, updated_at',
      )
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

  // ── Mapping stats — mirrors getOutputsPageData + MappingContent header ─
  //
  // `primaryTfms`: non-rejected TFMs that represent actual (or value-assigned)
  // target-field mappings. Bare acks (is_acknowledged=true AND
  // combination_type IS NULL) are excluded because they count as
  // "acknowledged unmapped target field", not as a mapping.
  const nonRejectedTfms = tfms.filter((t) => t.status !== 'rejected')
  const primaryTfms = nonRejectedTfms.filter(
    (t) => !(t.is_acknowledged && t.combination_type === null),
  )
  const approvedPrimaryTfms = primaryTfms.filter((t) => t.status === 'approved')

  // Group MS by TFM for primary-row lookups (ordinal=0).
  const msByTfmId = new Map<string, MappingSourceRow[]>()
  for (const ms of mappingSources) {
    if (!tfmIdSet.has(ms.target_field_mapping_id)) continue
    const list = msByTfmId.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    msByTfmId.set(ms.target_field_mapping_id, list)
  }
  for (const list of msByTfmId.values()) list.sort((a, b) => a.ordinal - b.ordinal)

  // A source field counts as "mapped" if ANY non-rejected TFM has an MS row
  // pointing at it (primary OR contributor). Mirrors the legacy FM union.
  const mappedSourceIds = new Set<string>()
  for (const tfm of nonRejectedTfms) {
    for (const ms of msByTfmId.get(tfm.id) ?? []) {
      if (ms.source_field_id) mappedSourceIds.add(ms.source_field_id)
    }
  }

  const primaryMappedTargetIds = new Set(primaryTfms.map((t) => t.target_field_id))

  // Acknowledged IDs come from two sources:
  //   - source_field_acknowledgments (source fields)
  //   - bare-ack TFMs (target fields)
  const sourceAckFieldIds = new Set((sourceAckRows ?? []).map((a) => a.source_field_id))
  const targetAckFieldIds = new Set(
    tfms.filter((t) => t.is_acknowledged && t.combination_type === null).map((t) => t.target_field_id),
  )
  const acknowledgedIds = new Set<string>([...sourceAckFieldIds, ...targetAckFieldIds])

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
    primaryTfms.length + unmappedSourceCount + unmappedTargetCount + acknowledgedCount
  const mappingApproved = approvedPrimaryTfms.length + acknowledgedCount

  // ── Transform scope — mirrors getOutputsPageData heuristic ─────────────
  const allTransforms = transformRows ?? []
  const tfmIdsWithTransforms = new Set(allTransforms.map((t) => t.target_field_mapping_id))
  const transformByTfmId = new Map(allTransforms.map((t) => [t.target_field_mapping_id, t]))

  const sourceFieldById = new Map((sourceFieldRows ?? []).map((f) => [f.id, f]))
  const targetFieldById = new Map((targetFieldRows ?? []).map((f) => [f.id, f]))

  // Evaluate fieldNeedsTransform against the primary MS row (ordinal=0) for
  // each TFM. VAs (no MS) are forced to needsTransform=true (identical to
  // the legacy `!fm.source_field_id ? true : …` branch).
  const scoredTfms = primaryTfms.map((tfm) => {
    const msList = msByTfmId.get(tfm.id) ?? []
    const primary = msList.find((m) => m.ordinal === 0) ?? null
    const isValueAssignment = primary === null && tfm.combination_type === 'custom_sql'
    const srcField = primary?.source_field_id ? sourceFieldById.get(primary.source_field_id) : null
    const tgtField = tfm.target_field_id ? targetFieldById.get(tfm.target_field_id) : null
    const hasTransformation = tfmIdsWithTransforms.has(tfm.id)

    const needsTransform = isValueAssignment
      ? true
      : fieldNeedsTransform({
          typeCompatibility: primary?.type_compatibility ?? '',
          confidence: tfm.confidence ?? 0,
          sourceDataType: srcField?.data_type ?? '',
          targetDataType: tgtField?.data_type ?? '',
          sourceFieldName: srcField?.name ?? '',
          targetFieldName: tgtField?.name ?? '',
          hasTransformation,
          needsTransformation: tfm.needs_transformation ?? null,
        })

    return { id: tfm.id, needsTransform }
  })

  const fieldsInScope = scoredTfms.filter((t) => t.needsTransform)
  const transformScope = fieldsInScope.length
  const transformApplied = fieldsInScope.filter(
    (t) => transformByTfmId.get(t.id)?.status === 'applied',
  ).length

  // ── Quality issues — in-flight only, mirrors Migration Center ──────────
  const issues = (qualityIssueRows ?? []) as QualityIssue[]
  const openInFlight = issues.filter((q) => q.status === 'open' && q.stage === 'in_flight')
  const openBlocking = openInFlight.filter((q) => q.severity === 'blocking').length
  const openWarnings = openInFlight.filter((q) => q.severity === 'warning').length

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
  const mappedTargetFieldIdSet = new Set(
    tfms.filter((t) => t.status === 'approved' && !!t.target_field_id).map((t) => t.target_field_id),
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
