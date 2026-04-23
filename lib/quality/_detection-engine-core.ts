/**
 * Business logic for the deterministic data quality detection engine.
 * NOT a 'use server' module.
 *
 * Server actions in `lib/quality/detection-engine.ts` are thin wrappers
 * that:
 *   1. Enforce auth via `await createClient()` + `auth.getUser()`
 *   2. Verify the project exists
 *   3. Call into the Internal functions here
 *
 * Functions here are directly testable with in-memory fixtures or with
 * the admin client against Heritage Core (see
 * `tests/integration/detection-engine-heritage.test.ts`), without the
 * `'use server'` + cookies/auth plumbing.
 *
 * Data model (Prompt 3d Option A rewrite, 2026-04-22)
 * ---------------------------------------------------
 * Legacy iteration was `for (fm of field_mappings)`. One FM per
 * source→target pair; multi-source TFMs had N FMs sharing a
 * `table_mapping_id`. That shape caused two problems in-flight:
 *
 *   - Staged branch (hasStaged=true): each of the 5 checks emits one
 *     `quality_issues` row keyed on the TARGET. With N identical FMs
 *     on a multi-source TFM, legacy emitted N DUPLICATE rows. Bug.
 *
 *   - Source branch (hasStaged=false): each check emits one row keyed
 *     on the SOURCE (which is distinct per FM contributor). Legacy
 *     correctly emitted N distinct rows, one per contributor source
 *     field. Desired.
 *
 * Option A fix: introduce an `InFlightCheckContext` flattener. For each
 * TFM, emit:
 *
 *   - hasStaged=true  → 1 context with the PRIMARY mapping_source only
 *                       (fixes staged-branch duplicate bug)
 *   - hasStaged=false → 1 context PER mapping_source (primary + every
 *                       contributor) — preserves source-branch per-
 *                       contributor attribution
 *
 * Shared helpers (rpcCount / rpcSamples / makeIssue) are exported from
 * this module and re-used by `runSourceDataChecks` in the wrapper file
 * to avoid duplication.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import type { QualityIssue } from '@/lib/types/database'

// ── Shared helpers ───────────────────────────────────────────────────────────
// Used by runInFlightChecksInternal (here) AND by runSourceDataChecks in the
// server-action wrapper file, which imports them back from this module.

export async function rpcCount(fn: string, params: Record<string, unknown>): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc(fn, params)
  if (error) {
    console.warn(`[detection] RPC ${fn} error:`, error.message)
    return 0
  }
  return Number(data ?? 0)
}

export async function rpcSamples(
  fn: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabaseAdmin.rpc(fn, params)
  if (error) {
    console.warn(`[detection] RPC ${fn} samples error:`, error.message)
    return []
  }
  return Array.isArray(data) ? data : []
}

export function makeIssue(
  overrides: Partial<QualityIssue> & {
    project_id: string
    table_id: string
    field_id: string | null
    stage: QualityIssue['stage']
    severity: QualityIssue['severity']
    title: string
    description: string
    affected_records: number
    issue_kind?: string | null
    affected_rows_sample?: Record<string, unknown>[]
    detection_source?: QualityIssue['detection_source']
  }
): Omit<QualityIssue, 'id' | 'created_at'> {
  const base: Omit<QualityIssue, 'id' | 'created_at'> = {
    ai_suggested_fix: null,
    ai_fix_options: null,
    downstream_impact: null,
    generated_sql: null,
    status: 'open',
    detection_source: 'auto',
    validation_rule_id: null,
    affected_rows_sample: null,
    issue_kind: null,
    ...overrides,
  }

  // Source-stage issues are always source data by definition — raw CSV / DB
  // data observed before any transform is applied. Auto-populate the breakdown
  // when the caller didn't set one explicitly so the UI's Root Cause filter
  // and chip render correctly.
  if (base.stage === 'source' && !base.root_cause_breakdown) {
    base.root_cause_breakdown = {
      source_data: overrides.affected_records,
      transform_error: 0,
      missing_transform: 0,
    }
  }

  return base
}

// ── Local row-shape types (from Supabase joins) ──────────────────────────────

type TMRow = {
  id: string
  project_id: string
  source_table_id: string
  target_table_id: string
}

type SFRow = {
  id: string
  name: string
  data_type: string
  inferred_type: string | null
  is_nullable: boolean
  is_primary_key: boolean
  table_id: string
}

type TFRow = {
  id: string
  name: string
  data_type: string
  is_nullable: boolean
  is_foreign_key: boolean
  fk_reference: string | null
  table_id: string
}

/**
 * Flattened view of one (TFM, mapping_source, TM) tuple for the in-flight
 * checks. The legacy code iterated over `field_mappings` directly; here
 * we build explicit contexts so the staged-vs-source branch fanout is
 * expressed by how many contexts are produced per TFM (see
 * `flattenTfmsForInFlightChecks`).
 *
 * Field names mirror the legacy iteration surface with one rename:
 * `fm_id` → `tfm_id`. Everything else (project_id, source_table_id,
 * target_table_id, source_field, target_field, needs_transformation,
 * hasStaged, tm_id, transform_status) is shape-compatible with the
 * legacy per-FM iteration so the 5 check functions read identically.
 */
export interface InFlightCheckContext {
  tfm_id: string
  tm_id: string
  project_id: string
  source_table_id: string
  target_table_id: string
  source_field: SFRow
  target_field: TFRow
  needs_transformation: boolean | null
  transform_status: string | null
  hasStaged: boolean
}

// ── TFM joined shape returned by the Supabase select() ──────────────────────

type MSJoined = {
  id: string
  source_table_id: string | null
  ordinal: number
  source_field: SFRow | SFRow[] | null
}

type TFMJoined = {
  id: string
  target_field_id: string
  needs_transformation: boolean | null
  mapping_sources: MSJoined[] | null
  target_field: TFRow | TFRow[] | null
  transformations: { id: string; status: string }[] | null
}

// Supabase's generated types sometimes widen 1:1 joins to `X | X[]`; these
// normalisers pick the single row without relaxing strictness on caller side.
function pickSingle<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null
  return Array.isArray(v) ? (v[0] ?? null) : v
}

/**
 * Build the list of InFlightCheckContexts from pre-fetched TFMs and TMs.
 *
 * Option A fanout (Prompt 3d, 2026-04-22):
 *
 *   hasStaged=true  → emit EXACTLY ONE context per TFM, using the primary
 *                     mapping_source (ordinal=0). This fixes the legacy
 *                     N-duplicate bug where multi-source TFMs produced
 *                     N identical staged-branch quality_issues rows.
 *
 *   hasStaged=false → emit ONE context per mapping_source (primary +
 *                     every contributor). Each contributor has a distinct
 *                     source_field, so each check produces a distinct
 *                     quality_issues row keyed on (source_table, source_field).
 *                     This preserves the legacy per-contributor attribution
 *                     that surfaces data issues in individual source columns.
 *
 * Exported for testability.
 */
export function flattenTfmsForInFlightChecks(
  projectId: string,
  tfms: TFMJoined[],
  tms: TMRow[],
  stagedMappingIds: Set<string>
): InFlightCheckContext[] {
  const tmByPair = new Map<string, TMRow>()
  for (const tm of tms) {
    tmByPair.set(`${tm.source_table_id}::${tm.target_table_id}`, tm)
  }

  const contexts: InFlightCheckContext[] = []

  for (const tfm of tfms) {
    const targetField = pickSingle(tfm.target_field)
    if (!targetField) continue

    const targetTableId = targetField.table_id
    const msRows = [...(tfm.mapping_sources ?? [])].sort((a, b) => a.ordinal - b.ordinal)
    if (msRows.length === 0) continue // bare-ack TFM — no source, no per-MS checks

    const primary = msRows[0]
    if (primary.ordinal !== 0 || !primary.source_table_id) continue

    const primaryTm = tmByPair.get(`${primary.source_table_id}::${targetTableId}`)
    if (!primaryTm) continue

    const hasStaged = stagedMappingIds.has(primaryTm.id)
    const transform = tfm.transformations?.[0] ?? null
    const transformStatus = transform?.status ?? null

    const msIter = hasStaged ? [primary] : msRows
    for (const ms of msIter) {
      if (!ms.source_table_id) continue
      const tm = tmByPair.get(`${ms.source_table_id}::${targetTableId}`)
      if (!tm) continue
      const sourceField = pickSingle(ms.source_field)
      if (!sourceField) continue

      contexts.push({
        tfm_id: tfm.id,
        tm_id: tm.id,
        project_id: projectId,
        source_table_id: ms.source_table_id,
        target_table_id: targetTableId,
        source_field: sourceField,
        target_field: targetField,
        needs_transformation: tfm.needs_transformation,
        transform_status: transformStatus,
        hasStaged,
      })
    }
  }

  return contexts
}

// ── Root-cause breakdown helper ──────────────────────────────────────────────

function computeRootCause(
  ctx: Pick<InFlightCheckContext, 'needs_transformation' | 'transform_status' | 'hasStaged'>,
  sourceCount: number,
  stagedCount: number
): { source_data: number; transform_error: number; missing_transform: number } {
  const hasApplied = ctx.transform_status === 'applied'
  const needsTransform = ctx.needs_transformation === true

  if (ctx.hasStaged && hasApplied) {
    const sourceOrigin = Math.min(sourceCount, stagedCount)
    const transformOrigin = Math.max(0, stagedCount - sourceCount)
    return { source_data: sourceOrigin, transform_error: transformOrigin, missing_transform: 0 }
  }

  if (needsTransform && !hasApplied) {
    return { source_data: 0, transform_error: 0, missing_transform: stagedCount }
  }

  return { source_data: stagedCount, transform_error: 0, missing_transform: 0 }
}

// ── Per-check functions ──────────────────────────────────────────────────────
//
// Each check reads a single InFlightCheckContext and a couple of shared
// lookup maps, and pushes zero or one `quality_issues` payload into
// `issuesToInsert`. Extracted out of the monolithic legacy loop so the
// Option A fanout + per-check signatures are independently testable.

type CheckArgs = {
  ctx: InFlightCheckContext
  sourceTableName: string
  targetTableName: string
  issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[]
}

async function checkLengthOverflow({
  ctx,
  sourceTableName,
  targetTableName,
  issuesToInsert,
}: CheckArgs): Promise<void> {
  // ── Check 8: String length truncation (BLOCKING)
  // Checks TRANSFORMED value against target length limit when staged data exists;
  // falls back to source data otherwise.
  const { target_field: tf, source_field: sf, hasStaged, tm_id, source_table_id, target_table_id, project_id } = ctx
  const targetType = tf.data_type?.toUpperCase() ?? ''
  const lengthMatch = targetType.match(/(?:CHAR|VARCHAR)\((\d+)\)/)
  if (!lengthMatch) return
  const maxLen = parseInt(lengthMatch[1], 10)

  let exceededCount = 0
  let samples: Record<string, unknown>[] = []

  if (hasStaged) {
    exceededCount = await rpcCount('dq_staged_length_exceeded', {
      p_mapping_id: tm_id,
      p_field: tf.name,
      p_max: maxLen,
    })
    if (exceededCount > 0) {
      samples = await rpcSamples('dq_staged_length_exceeded_samples', {
        p_mapping_id: tm_id,
        p_field: tf.name,
        p_max: maxLen,
        p_limit: 5,
      })
    }
  } else {
    exceededCount = await rpcCount('dq_length_exceeded_count', {
      p_table_id: source_table_id,
      p_field: sf.name,
      p_max: maxLen,
    })
    if (exceededCount > 0) {
      samples = await rpcSamples('dq_length_exceeded_samples', {
        p_table_id: source_table_id,
        p_field: sf.name,
        p_max: maxLen,
        p_limit: 5,
      })
    }
  }

  if (exceededCount === 0) return

  const dataNote = hasStaged
    ? ''
    : ' (checked against source data — stage transforms for transformed validation)'

  // Always compute a clean breakdown via the helper.
  // When not staged, sourceCount == stagedCount == exceededCount, so the
  // helper routes to missing_transform (if needs_transformation) or source_data.
  let sourceExceededCount = exceededCount
  if (hasStaged) {
    sourceExceededCount = await rpcCount('dq_length_exceeded_count', {
      p_table_id: source_table_id,
      p_field: sf.name,
      p_max: maxLen,
    })
  }
  const rcBreakdown = computeRootCause(ctx, sourceExceededCount, exceededCount)

  let rcRootCause: string | undefined
  if (rcBreakdown.transform_error > 0) {
    rcRootCause = `Transform error — transform output exceeds ${maxLen} chars`
  } else if (rcBreakdown.missing_transform > 0) {
    rcRootCause = `Missing transform — values exceed ${maxLen} chars and no transform is applied to shorten them`
  } else {
    rcRootCause = `Source data — values already exceed ${maxLen} chars at source`
  }

  const fieldTitle = `${sourceTableName}.${sf.name}`

  issuesToInsert.push(
    makeIssue({
      project_id,
      table_id: hasStaged ? target_table_id : source_table_id,
      field_id: hasStaged ? tf.id : sf.id,
      stage: 'in_flight',
      severity: 'blocking',
      title: hasStaged ? `${targetTableName}.${tf.name}` : fieldTitle,
      description: `Transformed ${tf.name} values exceed target field limit (${maxLen} chars) — ${exceededCount} records affected${dataNote}`,
      affected_records: Number(exceededCount),
      affected_rows_sample: samples,
      issue_kind: 'length_overflow',
      detection_source: 'manual_scan',
      root_cause: rcRootCause,
      root_cause_breakdown: rcBreakdown,
    })
  )
}

async function checkCaseInconsistency({
  ctx,
  targetTableName,
  issuesToInsert,
}: CheckArgs): Promise<void> {
  // ── Check 9: Case inconsistency (WARNING)
  // When staged data exists, check the TRANSFORMED values; target codes should
  // already be uppercase, so this should be rare after a transform is applied.
  const { target_field: tf, source_field: sf, hasStaged, tm_id, source_table_id, target_table_id, project_id } = ctx
  const targetIsUpper =
    targetTableName === targetTableName.toUpperCase() &&
    tf.name === tf.name.toUpperCase() &&
    tf.name.includes('_')
  if (!targetIsUpper) return

  let mixedCount = 0
  if (hasStaged) {
    mixedCount = await rpcCount('dq_staged_mixed_case_count', {
      p_mapping_id: tm_id,
      p_field: tf.name,
    })
  } else {
    mixedCount = await rpcCount('dq_mixed_case_count', {
      p_table_id: source_table_id,
      p_field: sf.name,
    })
  }
  if (mixedCount === 0) return

  issuesToInsert.push(
    makeIssue({
      project_id,
      table_id: hasStaged ? target_table_id : source_table_id,
      field_id: hasStaged ? tf.id : sf.id,
      stage: 'in_flight',
      severity: 'warning',
      title: `${targetTableName}.${tf.name}`,
      description: `Case inconsistency: ${hasStaged ? 'transformed' : 'source'} values contain lowercase, target expects uppercase — ${mixedCount} records affected`,
      affected_records: Number(mixedCount),
      issue_kind: 'case_inconsistency',
      detection_source: 'manual_scan',
      root_cause_breakdown: {
        source_data: Number(mixedCount),
        transform_error: 0,
        missing_transform: 0,
      },
    })
  )
}

async function checkOrphanedFK({
  ctx,
  targetTableName,
  issuesToInsert,
  targetNameToMappingId,
  stagedMappingIds,
  mappingIdToSourceTableId,
}: CheckArgs & {
  targetNameToMappingId: Map<string, string>
  stagedMappingIds: Set<string>
  mappingIdToSourceTableId: Map<string, string>
}): Promise<void> {
  // ── Check 10: FK referential integrity against staged parent data (BLOCKING)
  // Only runs when both the child and parent table mappings have been staged.
  const { target_field: tf, source_field: sf, hasStaged, tm_id, source_table_id, target_table_id, project_id } = ctx
  if (!hasStaged || !tf.is_foreign_key || !tf.fk_reference) return

  const [parentTableName, parentFieldName] = tf.fk_reference.split('.')
  if (!parentTableName || !parentFieldName) return

  const parentMappingId = targetNameToMappingId.get(parentTableName.toUpperCase())
  if (!parentMappingId || !stagedMappingIds.has(parentMappingId)) return

  const orphanCount = await rpcCount('dq_staged_orphaned_fk_count', {
    p_child_mapping_id: tm_id,
    p_child_field: tf.name,
    p_parent_mapping_id: parentMappingId,
    p_parent_field: parentFieldName,
  })
  if (orphanCount === 0) return

  const samples = await rpcSamples('dq_staged_orphaned_fk_samples', {
    p_child_mapping_id: tm_id,
    p_child_field: tf.name,
    p_parent_mapping_id: parentMappingId,
    p_parent_field: parentFieldName,
    p_limit: 5,
  })

  // Root cause: check if the same orphans existed in source data
  let rcRootCause: string | undefined
  let rcBreakdown: QualityIssue['root_cause_breakdown']
  const parentSourceTableId = mappingIdToSourceTableId.get(parentMappingId)
  if (parentSourceTableId) {
    const sourceOrphanCount = await rpcCount('dq_orphaned_fk_count', {
      p_source_table_id: source_table_id,
      p_source_field: sf.name,
      p_target_table_id: parentSourceTableId,
      p_target_field: parentFieldName,
    })
    const rcSourceOrigin = Math.min(sourceOrphanCount, orphanCount)
    const rcTransformOrigin = Math.max(0, orphanCount - sourceOrphanCount)
    rcRootCause =
      rcSourceOrigin > 0
        ? `Source data — ${rcSourceOrigin} orphaned reference${rcSourceOrigin !== 1 ? 's' : ''} existed in source`
        : 'Transform error — transform produced values not matching parent table'
    rcBreakdown = {
      source_data: rcSourceOrigin,
      transform_error: rcTransformOrigin,
      missing_transform: 0,
    }
  }

  issuesToInsert.push(
    makeIssue({
      project_id,
      table_id: target_table_id,
      field_id: tf.id,
      stage: 'in_flight',
      severity: 'blocking',
      title: `${targetTableName}.${tf.name}`,
      description: `Referential integrity violation: ${orphanCount} staged record${orphanCount !== 1 ? 's' : ''} in ${targetTableName}.${tf.name} reference values not found in staged ${parentTableName}.${parentFieldName} — these records will fail on load`,
      affected_records: Number(orphanCount),
      affected_rows_sample: samples,
      issue_kind: 'orphaned_fk',
      detection_source: 'manual_scan',
      root_cause: rcRootCause,
      root_cause_breakdown: rcBreakdown,
    })
  )
}

async function checkNullRequired({
  ctx,
  sourceTableName,
  targetTableName,
  issuesToInsert,
}: CheckArgs): Promise<void> {
  // ── Check 11: Non-nullable target with null/empty values (BLOCKING)
  // When staged data exists, check the TRANSFORMED value for the TARGET field.
  const { target_field: tf, source_field: sf, hasStaged, tm_id, source_table_id, target_table_id, project_id } = ctx
  if (tf.is_nullable || !sf.is_nullable) return

  let nullCount = 0
  if (hasStaged) {
    nullCount = await rpcCount('dq_staged_null_count', {
      p_mapping_id: tm_id,
      p_field: tf.name,
    })
  } else {
    nullCount = await rpcCount('dq_null_count', {
      p_table_id: source_table_id,
      p_field: sf.name,
    })
  }
  if (nullCount === 0) return

  const dataNote = hasStaged
    ? ''
    : ' (checked against source data — stage transforms for transformed validation)'

  // Always compute a clean breakdown via the helper. Fetch the source
  // null count for the split when staged; otherwise sourceCount == stagedCount.
  let sourceNullCount = nullCount
  if (hasStaged) {
    sourceNullCount = await rpcCount('dq_null_count', {
      p_table_id: source_table_id,
      p_field: sf.name,
    })
  }
  const rcBreakdown = computeRootCause(ctx, sourceNullCount, nullCount)

  let rcRootCause: string | undefined
  if (rcBreakdown.transform_error > 0 && rcBreakdown.source_data > 0) {
    rcRootCause = `${rcBreakdown.source_data} from source data, ${rcBreakdown.transform_error} introduced by transform`
  } else if (rcBreakdown.transform_error > 0) {
    rcRootCause = 'Transform error — source values were valid but transform produced null'
  } else if (rcBreakdown.missing_transform > 0) {
    rcRootCause =
      'Missing transform — source has null values and no transform is applied to handle them'
  } else {
    rcRootCause = 'Source data — values were null at source'
  }

  const fieldTitle = `${sourceTableName}.${sf.name}`

  issuesToInsert.push(
    makeIssue({
      project_id,
      table_id: hasStaged ? target_table_id : source_table_id,
      field_id: hasStaged ? tf.id : sf.id,
      stage: 'in_flight',
      severity: 'blocking',
      title: hasStaged ? `${targetTableName}.${tf.name}` : fieldTitle,
      description: `Target field ${targetTableName}.${tf.name} is non-nullable but has ${nullCount} null/empty values after transformation — these records will fail on load${dataNote}`,
      affected_records: Number(nullCount),
      issue_kind: 'null_required',
      detection_source: 'manual_scan',
      root_cause: rcRootCause,
      root_cause_breakdown: rcBreakdown,
    })
  )
}

// ── Check 12 (unmapped required target) — global, not per-TFM ────────────────

async function checkUnmappedRequiredTargets(
  projectId: string,
  issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[]
): Promise<void> {
  const { data: datasets } = await supabaseAdmin
    .from('datasets')
    .select('id')
    .eq('project_id', projectId)
    .eq('role', 'target')

  if (!datasets || datasets.length === 0) return

  const targetDatasetIds = datasets.map((d) => d.id)
  const { data: targetTablesData } = await supabaseAdmin
    .from('tables')
    .select('id, name, dataset_id')
    .in('dataset_id', targetDatasetIds)

  if (!targetTablesData) return

  for (const tbl of targetTablesData) {
    const { data: requiredFields } = await supabaseAdmin
      .from('fields')
      .select('id, name')
      .eq('table_id', tbl.id)
      .eq('is_nullable', false)

    if (!requiredFields) continue

    for (const rf of requiredFields) {
      // Prompt 3d decision (Q2, 2026-04-22): preserve legacy "unmapped_required"
      // semantics for acknowledged-but-unmapped targets. In the new model a
      // user can create a bare-ack TFM (`is_acknowledged=true`, zero
      // mapping_sources) to say "this required target is known-absent".
      // Legacy detection-engine counted field_mappings (which always had a
      // source_field), so a bare-ack had no FM and Check 12 emitted an
      // issue — surfacing the acknowledgment for the user to re-review.
      // We mirror that here by requiring an inner join on mapping_sources:
      // bare-ack TFMs are excluded from the mapped-count and therefore still
      // raise Check 12. Product owners can revisit if this proves noisy.
      const { count } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, mapping_sources!inner(id)', { count: 'exact', head: true })
        .eq('target_field_id', rf.id)

      if ((count ?? 0) === 0) {
        issuesToInsert.push(
          makeIssue({
            project_id: projectId,
            table_id: tbl.id,
            field_id: rf.id,
            stage: 'in_flight',
            severity: 'blocking',
            title: `${tbl.name}.${rf.name}`,
            description: `Required target field ${tbl.name}.${rf.name} has no source mapping — all records will fail on load unless a default value is provided`,
            affected_records: 0,
            issue_kind: 'unmapped_required',
            detection_source: 'manual_scan',
            // By definition: an unmapped required field is always a missing
            // mapping/transform. affected_records is 0 (no data flows at all),
            // so use 1 as a symbolic count to surface the "Missing transform"
            // chip in the UI.
            root_cause: 'Missing transform — required target field has no source mapping',
            root_cause_breakdown: { source_data: 0, transform_error: 0, missing_transform: 1 },
          })
        )
      }
    }
  }
}

// ── runInFlightChecksInternal ────────────────────────────────────────────────
//
// Pre-conditions (enforced by the server-action wrapper in
// `detection-engine.ts`):
//
//   1. Caller is authenticated.
//   2. `projectId` references an existing row in `projects`.
//
// This function MUTATES `quality_issues`:
//
//   - Deletes existing in-flight issues for this project where
//     `detection_source IN ('auto', 'manual_scan')`.
//   - Inserts fresh in-flight issues based on the 5 structural checks
//     (8 length_overflow, 9 case_inconsistency, 10 orphaned_fk,
//     11 null_required, 12 unmapped_required).

export async function runInFlightChecksInternal(projectId: string): Promise<void> {
  // Delete existing in-flight issues for this project (re-scan is idempotent)
  await supabaseAdmin
    .from('quality_issues')
    .delete()
    .eq('project_id', projectId)
    .eq('stage', 'in_flight')
    .in('detection_source', ['auto', 'manual_scan'])

  // Fetch all TFMs for the project with joined target_field, mapping_sources
  // (with nested source_field), and transformations.
  //
  // Note on filters: legacy detection-engine applied NO status or
  // is_acknowledged filters to `field_mappings`, so Checks 8–11 ran for
  // approved, needs_review, and (if present) rejected rows alike, and
  // regardless of any source-side ack. We preserve that surface here — no
  // .eq('status', …) / .eq('is_acknowledged', …) on TFM. TFMs with zero
  // mapping_sources (bare-ack) are naturally skipped by the flattener
  // because there is no source field to check against.
  const { data: tfmRows } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      `
      id,
      target_field_id,
      needs_transformation,
      mapping_sources (
        id,
        source_table_id,
        ordinal,
        source_field:fields!source_field_id (id, name, data_type, inferred_type, is_nullable, is_primary_key, table_id)
      ),
      target_field:fields!target_field_id (id, name, data_type, is_nullable, is_foreign_key, fk_reference, table_id),
      transformations ( id, status )
    `
    )
    .eq('project_id', projectId)

  const tfms = (tfmRows ?? []) as unknown as TFMJoined[]

  // Check 12 is global (runs even when there are no TFMs), so we always
  // execute it after per-TFM checks.
  if (tfms.length === 0) {
    const issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[] = []
    await checkUnmappedRequiredTargets(projectId, issuesToInsert)
    if (issuesToInsert.length > 0) {
      const { error } = await supabaseAdmin.from('quality_issues').insert(issuesToInsert)
      if (error) {
        console.error('[detection] Failed to insert in-flight issues:', error.message)
      }
    }
    return
  }

  // Fetch table_mappings for the project — needed to resolve (source_table_id,
  // target_table_id) pairs to a tm.id used by the staged RPC helpers.
  const { data: tmRowsRaw } = await supabaseAdmin
    .from('table_mappings')
    .select('id, project_id, source_table_id, target_table_id')
    .eq('project_id', projectId)
  const tms = (tmRowsRaw ?? []) as TMRow[]

  // Determine which TMs have staged data (transforms applied).
  const uniqueTmIds = [...new Set(tms.map((tm) => tm.id))]
  const stagedMappingIds = new Set<string>()
  for (const tmId of uniqueTmIds) {
    const { count } = await supabaseAdmin
      .from('staged_data_rows')
      .select('id', { count: 'exact', head: true })
      .eq('table_mapping_id', tmId)
      .limit(1)
    if ((count ?? 0) > 0) stagedMappingIds.add(tmId)
  }

  // Fetch table names (source + target) for title/description + FK lookup.
  const allTableIds = [
    ...new Set<string>([
      ...tms.map((t) => t.source_table_id),
      ...tms.map((t) => t.target_table_id),
    ]),
  ]
  const { data: tablesData } = await supabaseAdmin
    .from('tables')
    .select('id, name')
    .in('id', allTableIds)
  const tableNameById = new Map<string, string>((tablesData ?? []).map((t) => [t.id, t.name]))

  // Build the Check 10 parent-table-name reverse lookup:
  // target table name (uppercase) → tm.id. Legacy semantics preserved: first
  // TM to claim a given target name wins (ties are rare; target names are
  // effectively unique per target dataset).
  const targetNameToMappingId = new Map<string, string>()
  for (const tm of tms) {
    const tName = tableNameById.get(tm.target_table_id)
    if (tName && !targetNameToMappingId.has(tName.toUpperCase())) {
      targetNameToMappingId.set(tName.toUpperCase(), tm.id)
    }
  }

  // Lookup: tm.id → source_table_id (used for FK root cause computation)
  const mappingIdToSourceTableId = new Map<string, string>()
  for (const tm of tms) {
    mappingIdToSourceTableId.set(tm.id, tm.source_table_id)
  }

  // Flatten TFMs × mapping_sources into per-check contexts using the
  // Option A fanout (primary-only on staged branch, per-MS on source branch).
  const contexts = flattenTfmsForInFlightChecks(projectId, tfms, tms, stagedMappingIds)

  const issuesToInsert: Omit<QualityIssue, 'id' | 'created_at'>[] = []

  for (const ctx of contexts) {
    const sourceTableName = tableNameById.get(ctx.source_table_id) ?? 'source'
    const targetTableName = tableNameById.get(ctx.target_table_id) ?? 'target'

    const sharedArgs: CheckArgs = { ctx, sourceTableName, targetTableName, issuesToInsert }

    await checkLengthOverflow(sharedArgs)
    await checkCaseInconsistency(sharedArgs)
    await checkOrphanedFK({
      ...sharedArgs,
      targetNameToMappingId,
      stagedMappingIds,
      mappingIdToSourceTableId,
    })
    await checkNullRequired(sharedArgs)
  }

  // Check 12 is global — once per project, not per TFM.
  await checkUnmappedRequiredTargets(projectId, issuesToInsert)

  if (issuesToInsert.length > 0) {
    const { error } = await supabaseAdmin.from('quality_issues').insert(issuesToInsert)
    if (error) {
      console.error('[detection] Failed to insert in-flight issues:', error.message)
    }
  }
}
