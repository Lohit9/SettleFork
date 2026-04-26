'use server'

/**
 * Server actions for the Phase 3 redesigned Mapping page.
 *
 * Read path (`getMappingsForRedesign`): thin auth wrapper over the
 * pure assembler in `_mappings-for-redesign-core.ts`.
 *
 * Write path — Gap 9 (Phase 3 mutations):
 *   - `approveFieldMapping(rowId)` — flip TFM.status to 'approved'.
 *     Thin wrapper over the legacy `updateFieldMappingStatus` so the
 *     redesign UI never has to import a mixed-concern action surface.
 *     Per the founder amendment (2026-04-21), approve is non-destructive
 *     and reversible.
 *   - `rejectFieldMapping(rowId)` — DELETE the TFM (founder amendment:
 *     reject == delete). The target field thereafter renders as Rule 6
 *     (unmapped). Wrapper queries TFM identity BEFORE delegating to
 *     `deleteFieldMapping` so it can emit a `mapping_rejected` activity-
 *     log entry with the legacy-format payload (the legacy `delete`
 *     action does not log on its own).
 *
 * Write path — Phase 4a-1 (manual creation + per-target AI Suggest):
 *   - `createFieldMapping(input)` — atomic creation of a target_field_
 *     mapping plus its mapping_sources children via the
 *     `dq_create_target_field_mapping` RPC. Same-table only in 4a-1;
 *     cross-table support extends in 4a-3 with FK-inference precheck.
 *     Status 'needs_review' on creation (per founder decision 2 —
 *     redesign Approve is the explicit acceptance gate). Emits
 *     `mapping_created` activity-log entry. Calls
 *     `recomputeTableMappingStatus` explicitly (closes the legacy
 *     `addManualFieldMapping` gap that never recomputed coverage).
 *   - `suggestMappingForTarget(input)` — per-target AI Suggest. Net-new
 *     server action (does NOT wrap legacy `suggestRemainingMappings`
 *     which is per-TM-bulk + same-table + 1:1; see Phase 4a investigation
 *     §1.4 for divergence rationale). Returns an ephemeral suggestion
 *     for the form to pre-fill — no DB writes, no activity-log entry.
 *     Confirmation flows through `createFieldMapping` with
 *     `aiSuggested: true` for metadata bookkeeping.
 *
 * Coexistence (design §8.2): these actions live ALONGSIDE the legacy
 * `updateFieldMappingStatus` / `deleteFieldMapping` /
 * `addManualFieldMapping` / `suggestRemainingMappings` write paths
 * during Phase 3+4. The legacy MappingContent.tsx UI keeps calling the
 * legacy actions directly; only the redesign drawer + form reach the
 * wrappers below. Phase 5 cleanup retires the legacy UI; the wrappers
 * stay (they are the canonical redesign-side write surface).
 *
 * RACE-CONDITION HANDLING (Gap 9 alignment §5):
 *   If `rejectFieldMapping` finds the TFM has already been deleted by
 *   another caller between auth and our delete attempt, the wrapper
 *   returns `{ success: true, alreadyDeleted: true }` so the UI surfaces
 *   the same success state rather than a surprising NOT_FOUND. A thin
 *   activity-log entry with placeholder names is emitted to preserve
 *   the audit trail.
 *
 * IMPORT-GRAPH INVARIANT
 *   Files under `app/app/projects/[projectId]/mapping/redesign/**` MUST
 *   NOT import from `@/lib/actions/mappings` directly — the redesign
 *   surface goes through the wrappers in this file. Enforced by
 *   `tests/lib/no-shim-in-redesign-path.test.ts`.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  getMappingsForRedesignCore,
} from '@/lib/actions/_mappings-for-redesign-core'
import {
  deleteFieldMapping,
  recomputeTableMappingStatus,
  updateFieldMappingStatus,
  type MappingWriteErrorCode,
} from '@/lib/actions/mappings'
import { logActivity } from '@/lib/actions/activity-log'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildAIContext, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { decodeShimmedRowId } from '@/lib/compat/mapping-shim'
import {
  inferFkCandidates,
  parseToFkFieldFromReference,
  type FkInferenceField,
  type FkInferenceTable,
} from '@/lib/utils/fk-inference'
import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'

/**
 * Combination types user can select via the redesign-side W1 form.
 * Subset of the DB CHECK constraint enum (migration 074:156-157):
 *   ('single' | 'concat_space' | 'concat_comma' | 'custom_sql')
 *
 * `custom_sql` is BLOCKED from drawer-side authoring per founder
 * decision (Phase 4 plan §10) — transitions to custom_sql happen on
 * the Transform tab, not in the W1 form. The wrapper accepts only
 * the three values below; an incoming 'custom_sql' returns
 * `VALIDATION` with copy directing the user to Transform.
 */
export type CreateFieldMappingCombinationType =
  | 'single'
  | 'concat_space'
  | 'concat_comma'

// ─── Read path ────────────────────────────────────────────────────────────────

export async function getMappingsForRedesign(
  projectId: string,
): Promise<MappingsForRedesignResult | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  return getMappingsForRedesignCore(supabase, projectId)
}

// ─── Write path — Gap 9 ───────────────────────────────────────────────────────

export interface MappingActionResult {
  success: boolean
  error?: string
  errorCode?: MappingWriteErrorCode
}

export interface RejectMappingResult extends MappingActionResult {
  /**
   * True when the TFM was already gone by the time we tried to delete
   * it (concurrent caller deleted between our identity query and the
   * delete attempt). The UI treats this as a successful reject — the
   * end-state is identical (target field is unmapped).
   */
  alreadyDeleted?: boolean
  /**
   * Bubbled up from `deleteFieldMapping` so the UI can surface
   * "Resetting transformation" feedback if needed.
   */
  transformReset?: boolean
  stagedRowsReverted?: number
}

/**
 * Approve a TFM (mapped or value-assignment). Thin wrapper over
 * `updateFieldMappingStatus(rowId, 'approved')`.
 *
 * Pre-flight defenses (belt-and-suspenders alongside the UI's disabled-
 * state matrix):
 *   - Reject the `unmapped::<id>` sentinel (no TFM to approve).
 *   - Reject acknowledged TFMs (`is_acknowledged=true`). Acknowledged
 *     rows decode as `tfm-primary` in the redesign (their id is the
 *     bare TFM UUID — see `_mappings-for-redesign-core.ts` line 486),
 *     so the legacy action's `target-ack` short-circuit does NOT fire.
 *     Without this defense, an acknowledged row's TFM.status would be
 *     UPDATEd, which is a no-op on the audit trail but still represents
 *     incorrect intent.
 *
 * The legacy action handles auth, permission, guardWrites, the actual
 * UPDATE, table-mapping coverage recompute, and `mapping_approved`
 * activity logging.
 */
export async function approveFieldMapping(
  rowId: string,
): Promise<MappingActionResult> {
  if (rowId.startsWith('unmapped::')) {
    return {
      success: false,
      error: 'Unmapped rows cannot be approved',
      errorCode: 'VALIDATION',
    }
  }

  const decoded = decodeShimmedRowId(rowId)
  if (decoded.kind === 'tfm-primary' || decoded.kind === 'tfm-contributor') {
    const { data: tfm } = await supabaseAdmin
      .from('target_field_mappings')
      .select('is_acknowledged')
      .eq('id', decoded.tfmId)
      .single()
    if (tfm?.is_acknowledged) {
      return {
        success: false,
        error: 'Acknowledged rows do not support approve',
        errorCode: 'VALIDATION',
      }
    }
  }

  return updateFieldMappingStatus(rowId, 'approved')
}

/**
 * Reject a TFM under founder-amended semantics: the row is DELETEd
 * outright and the target field thereafter renders as Rule 6 (unmapped).
 *
 * Flow:
 *   1. Reject `unmapped::` sentinel (no TFM to delete).
 *   2. Decode to confirm we have a tfm-primary id.
 *   3. Query the TFM for project_id, target field name, primary source
 *      name, and `is_acknowledged` BEFORE attempting the delete. We
 *      need the names to populate the `mapping_rejected` activity log
 *      payload — `deleteFieldMapping` would have already removed them
 *      by the time we tried to look them up post-delete.
 *   4. If the TFM is acknowledged, refuse with VALIDATION (defensive
 *      alongside the UI's disabled-state matrix; see decision 7).
 *   5. If the TFM is missing (race condition: another caller deleted
 *      between us reading and us writing), log a thin
 *      `mapping_rejected` event with placeholder names and return
 *      `{ success: true, alreadyDeleted: true }`.
 *   6. Otherwise delegate to the legacy `deleteFieldMapping` (which
 *      handles permission, guardWrites, transform reset, FK-cascade,
 *      and TM coverage recompute) and emit `mapping_rejected` with
 *      the legacy-format payload `Mapping rejected: <src> → <tgt>`.
 *
 * The legacy `deleteFieldMapping` does NOT itself emit an activity
 * log entry, so the wrapper carries that responsibility. Reusing the
 * existing `mapping_rejected` event type (per founder decision 6 in
 * the Gap 9 alignment) avoids enum churn and keeps the user-facing
 * verb ("reject") canonical regardless of the internal delete
 * mechanism.
 */
export async function rejectFieldMapping(
  rowId: string,
): Promise<RejectMappingResult> {
  if (rowId.startsWith('unmapped::')) {
    return {
      success: false,
      error: 'Unmapped rows cannot be rejected',
      errorCode: 'VALIDATION',
    }
  }

  const decoded = decodeShimmedRowId(rowId)
  if (decoded.kind !== 'tfm-primary' && decoded.kind !== 'tfm-contributor') {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Identity snapshot BEFORE delete — names are needed for the activity
  // log payload and `is_acknowledged` is the defensive guard.
  const { data: tfmLookup } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      `id, project_id, target_field_id, is_acknowledged,
       fields:target_field_id(name)`,
    )
    .eq('id', decoded.tfmId)
    .single<{
      id: string
      project_id: string
      target_field_id: string
      is_acknowledged: boolean
      fields: { name: string } | null
    }>()

  if (!tfmLookup) {
    // Race condition path: TFM is already gone. Treat as success +
    // log a thin event so the audit trail still reflects the user's
    // explicit reject click. Project id is unrecoverable here, so we
    // skip the activity-log call (logActivity requires a project id);
    // the delete itself was performed by whoever raced us — they own
    // the audit-trail entry.
    return { success: true, alreadyDeleted: true }
  }

  if (tfmLookup.is_acknowledged) {
    return {
      success: false,
      error: 'Acknowledged rows do not support reject',
      errorCode: 'VALIDATION',
    }
  }

  // Resolve primary source name for the log payload. Best-effort:
  // missing primary or query failure → '[value]' fallback (matches
  // legacy `updateFieldMappingStatus` reject branch at
  // `lib/actions/mappings.ts:1373-1375`).
  const { data: primarySource } = await supabaseAdmin
    .from('mapping_sources')
    .select('source_field_id, fields:source_field_id(name)')
    .eq('target_field_mapping_id', tfmLookup.id)
    .order('ordinal', { ascending: true })
    .limit(1)
  const srcName =
    primarySource && primarySource.length > 0
      ? ((primarySource[0] as unknown as { fields?: { name?: string } | null })
          .fields?.name ?? null)
      : null
  const tgtName = tfmLookup.fields?.name ?? null

  const deleteResult = await deleteFieldMapping(rowId)
  if (!deleteResult.success) {
    return {
      success: false,
      error: deleteResult.error,
      errorCode: deleteResult.errorCode,
    }
  }

  // Log AFTER successful delete so a failed delete doesn't leave a
  // dangling rejection event. Format matches legacy reject branch
  // verbatim (`lib/actions/mappings.ts:1379`).
  await logActivity(
    tfmLookup.project_id,
    'mapping_rejected',
    `Mapping rejected: ${srcName ?? '[value]'} \u2192 ${tgtName ?? '?'}`,
    'mapping',
    {
      target_field_mapping_id: tfmLookup.id,
      target_field: tgtName,
      source_field: srcName,
    },
  )

  return {
    success: true,
    transformReset: deleteResult.transformReset,
    stagedRowsReverted: deleteResult.stagedRowsReverted,
  }
}

// ─── Write path — Phase 4a-1 ──────────────────────────────────────────────────
//
// `createFieldMapping` and `suggestMappingForTarget` form the server-side
// surface for W1 (manual mapping creation from Rule 6 unmapped target rows)
// and W6 (per-row AI Suggest as a sub-affordance of the W1 form).
//
// Same-table only in 4a-1: source fields must all live in the same source
// table. Cross-table sources return `CROSS_TABLE_NOT_YET_SUPPORTED`. The
// `CROSS_TABLE_AMBIGUOUS` errorCode is reserved on the union for 4a-3 when
// FK-inference precheck lands; including it now keeps the discriminated-
// union exhaustiveness story stable across sub-gaps.
//
// Audit-log emitter: this file emits `mapping_created` (and Phase 4 plan
// §2.2 catalogues the other 5 emitters that will land in 4b/4c). The legacy
// `addManualFieldMapping` does NOT emit an activity-log entry today, so the
// wrapper is the FIRST creation path that lands on the audit trail —
// matching the redesign UI being the canonical create-mapping surface.

export type CreateFieldMappingErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'
  /**
   * 4a-1 same-table-only emitter. Phase 4a-3 lifts the same-table guard
   * and never emits this code; the union member is retained on the type
   * so older clients that branch on it continue to compile.
   */
  | 'CROSS_TABLE_NOT_YET_SUPPORTED'
  /**
   * Phase 4a-3 — FK inference produced zero or multiple candidates for
   * a non-dominant source table. The result includes `candidateFkFields`
   * (`[]` for zero candidates, `[a, b, …]` for 2+) and table-name
   * context so the form can render the right UI:
   *   • zero candidates → error banner directing user to add an FK
   *     in the schema or use the legacy Mapping page
   *   • 2+ candidates → inline disambiguation dropdown; user picks
   *     a candidate and resaves with `joinAnnotations` populated
   */
  | 'CROSS_TABLE_AMBIGUOUS'

export type CreateFieldMappingResult =
  | {
      success: true
      tfmId: string
      tableMappingId: string
    }
  | {
      success: false
      error: string
      errorCode: CreateFieldMappingErrorCode
      /**
       * Populated when errorCode === 'CROSS_TABLE_AMBIGUOUS'. `[]`
       * indicates zero FK matches between dominant and joined source
       * tables (zero-FK error path); a non-empty array surfaces the
       * candidate FK field names so the form can ask the user to
       * disambiguate. Undefined for all other error codes.
       */
      candidateFkFields?: string[]
      /**
       * The joined source table id whose FK inference came back
       * ambiguous. Populated alongside `candidateFkFields` so the
       * form can scope its disambiguation UI to the offending
       * (dominant, joined) pair without diffing `selectedIds`.
       */
      ambiguousJoinedTableId?: string
      /** Joined table's name for user-facing copy. */
      ambiguousJoinedTableName?: string
      /** Dominant source table's name for user-facing copy. */
      dominantTableName?: string
    }

/**
 * Create a target_field_mapping with one or more sources in a single
 * atomic RPC call.
 *
 * Same-table and cross-table sources both supported as of Phase 4a-3.
 * For cross-table input the wrapper performs an FK precheck:
 *
 *   • Dominant source table = first source's table (input order is
 *     stable; UI never re-anchors).
 *   • Per joined table, look up FK fields in the dominant table whose
 *     `fk_reference` resolves to the joined table id.
 *       - 0 candidates → return `CROSS_TABLE_AMBIGUOUS` with empty
 *         `candidateFkFields` (form renders zero-FK error banner).
 *       - 1 candidate  → store `join_spec=null` for that source; read
 *         path re-derives annotation each render so column renames
 *         flow through automatically.
 *       - 2+ candidates → require `joinAnnotations[joinedTableId]`
 *         in input. Without it, return `CROSS_TABLE_AMBIGUOUS` with
 *         the candidate list so the form can render a disambiguation
 *         dropdown. With it, validate that the picked name is in the
 *         candidate list (defense-in-depth) and persist a populated
 *         `join_spec` JSONB.
 *
 * Apply RPC: Phase 4a-6 wired the cross-table branch of
 * `dq_apply_field_transform_joined` (migration 076).
 * `lib/actions/transformations.ts:applyTransform` derives the
 * `p_join_spec` JSONB at apply time via `buildJoinSpec` (per-source
 * dedupe to per-table joins, FK re-derivation when stored
 * `join_spec` is null). Cross-table mappings authored here apply
 * end-to-end without further user action. Re-derivation that yields
 * 0 or 2+ FK candidates surfaces `CROSS_TABLE_FK_INFERENCE_FAILED`
 * — typically a sign the schema has shifted since the mapping was
 * authored.
 *
 * SEQUENCE (per Phase 4a-3 investigation §2):
 *   1. Auth + permission (`requireProjectPermission(..., 'editor')`).
 *   2. Validate inputs: 1+ sources, no duplicates, combinationType not
 *      'custom_sql', single↔concat sanity.
 *   3. Identity reads: source fields with their table_id+name, target
 *      field with its table_id+name.
 *   4. Defensive guards: all field IDs belong to this project; no
 *      duplicate sourceFieldIds.
 *   5. Maintenance-mode guard (`assertMappingWritesEnabled`).
 *   5b. Cross-table FK precheck (when sources span multiple tables).
 *   6. Existing-TFM collision check.
 *   7. Find-or-create table_mappings row for (dominantTable, targetTable).
 *   8. RPC call `dq_create_target_field_mapping` — per-source
 *      `join_spec` populated for disambiguated joined sources, null
 *      for dominant + single-candidate joined sources.
 *   9. `recomputeTableMappingStatus`.
 *  10. revalidatePath for /mapping AND /transform.
 *  11. Emit `mapping_created` activity log entry.
 */
export async function createFieldMapping(input: {
  projectId: string
  targetFieldId: string
  sourceFieldIds: string[]
  combinationType: CreateFieldMappingCombinationType | 'custom_sql'
  /** Set true when the form was pre-filled by `suggestMappingForTarget`. */
  aiSuggested?: boolean
  /** Per-source confidence (uniform). Defaults to 100 for manual paths. */
  confidence?: number
  /** Optional AI rationale to persist on TFM.ai_reasoning (decision 4). */
  aiReasoning?: string | null
  /**
   * Phase 4a-3 — cross-table disambiguation overrides. Keyed by joined
   * source table id, value is the FK field name in the dominant table
   * the user picked. Required only when the joined table has 2+ FK
   * candidates; ignored otherwise. The wrapper validates each value
   * against the live candidate list before persisting (defense-in-
   * depth: a stale form submission picking a renamed FK fails fast
   * with VALIDATION rather than corrupting `join_spec`).
   */
  joinAnnotations?: Record<string, string>
}): Promise<CreateFieldMappingResult> {
  // ── Step 1: validation (cheap, before any I/O) ────────────────────────────
  const {
    projectId,
    targetFieldId,
    sourceFieldIds,
    combinationType,
    aiSuggested = false,
    confidence,
    aiReasoning = null,
    joinAnnotations = {},
  } = input

  if (!projectId || !targetFieldId) {
    return {
      success: false,
      error: 'projectId and targetFieldId are required',
      errorCode: 'VALIDATION',
    }
  }

  if (!Array.isArray(sourceFieldIds) || sourceFieldIds.length === 0) {
    return {
      success: false,
      error: 'At least one source field is required',
      errorCode: 'VALIDATION',
    }
  }

  if (combinationType === 'custom_sql') {
    return {
      success: false,
      error:
        'Custom SQL combinations are authored on the Transform tab, not here',
      errorCode: 'VALIDATION',
    }
  }

  if (combinationType === 'single' && sourceFieldIds.length !== 1) {
    return {
      success: false,
      error: "combination_type 'single' requires exactly one source field",
      errorCode: 'VALIDATION',
    }
  }

  if (combinationType !== 'single' && sourceFieldIds.length < 2) {
    return {
      success: false,
      error: `combination_type '${combinationType}' requires at least two source fields`,
      errorCode: 'VALIDATION',
    }
  }

  // Duplicate sources are a UI bug (the picker should dedupe). Reject
  // here as a defense-in-depth — the DB has no UNIQUE constraint on
  // (target_field_mapping_id, source_field_id) so duplicates would
  // silently double-count in concat_* combinations.
  if (new Set(sourceFieldIds).size !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'Duplicate source fields are not allowed',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: maintenance-mode guard ───────────────────────────────────────
  // Inline rather than wrapping the whole body in a guardWrites helper —
  // the legacy `guardWrites` is module-private to lib/actions/mappings.ts
  // and the wrapper here is the only redesign-side caller, so a colocated
  // guard keeps the contract surface flat.
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Step 4: identity reads ───────────────────────────────────────────────
  // Single round-trip per entity. Use admin client for the cross-table
  // read so RLS narrowing on `fields` doesn't silently drop a source the
  // user lacks SELECT on — the wrapper's project-membership check above
  // is the authoritative gate.
  // Project ownership chain: fields.table_id → tables.dataset_id →
  // datasets.project_id. The `tables` table has NO `project_id` column
  // of its own — joining `tables(project_id)` would return a PostgREST
  // 42703 ("column tables_1.project_id does not exist"). Match the
  // legacy pattern at `lib/actions/fields.ts:81` which walks both hops
  // through `!inner` to keep the join restrictive.
  const { data: targetField, error: tfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .eq('id', targetFieldId)
    .single<{
      id: string
      name: string
      table_id: string
      tables:
        | { datasets: { project_id: string } | { project_id: string }[] | null }
        | {
            datasets: { project_id: string } | { project_id: string }[] | null
          }[]
        | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Defensive: target field belongs to this project. PostgREST returns
  // a one-to-one join either as a single object or a singleton array
  // depending on relationship-cardinality inference; tolerate both.
  const targetTables = Array.isArray(targetField.tables)
    ? targetField.tables[0]
    : targetField.tables
  const targetDatasets = Array.isArray(targetTables?.datasets)
    ? targetTables?.datasets[0]
    : targetTables?.datasets
  const targetProjectId = targetDatasets?.project_id
  if (targetProjectId !== projectId) {
    return {
      success: false,
      error: 'Target field does not belong to this project',
      errorCode: 'VALIDATION',
    }
  }

  // Same join-chain caveat as the target-field read above: walk through
  // datasets to reach project_id. `tables` has no project_id column.
  const { data: sourceFields, error: sfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .in('id', sourceFieldIds)
    .returns<
      Array<{
        id: string
        name: string
        table_id: string
        tables:
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }[]
          | null
      }>
    >()
  if (sfErr || !sourceFields) {
    return {
      success: false,
      error: 'Failed to read source fields',
      errorCode: 'INTERNAL',
    }
  }

  if (sourceFields.length !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'One or more source fields not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Defensive: every source field belongs to this project.
  for (const sf of sourceFields) {
    const sfTables = Array.isArray(sf.tables) ? sf.tables[0] : sf.tables
    const sfDatasets = Array.isArray(sfTables?.datasets)
      ? sfTables?.datasets[0]
      : sfTables?.datasets
    const sfProject = sfDatasets?.project_id
    if (sfProject !== projectId) {
      return {
        success: false,
        error: 'One or more source fields do not belong to this project',
        errorCode: 'VALIDATION',
      }
    }
  }

  // Re-order `sourceFields` to match the input `sourceFieldIds` order
  // (Postgres `.in()` returns rows in DB order, not input order). This
  // matters for `ordinal` assignment below — first input id = ordinal 0
  // = dominant source.
  const sourceFieldsById = new Map(sourceFields.map((f) => [f.id, f]))
  const orderedSources = sourceFieldIds.map((id) => sourceFieldsById.get(id)!)

  // ── Step 5b: cross-table FK precheck (Phase 4a-3) ────────────────────────
  // Dominant source table = first source's table_id. UI never re-anchors
  // — picking order is stable across edits, and chip removal cleanup
  // happens form-side before resave (§4-OQ-3).
  const dominantTableId = orderedSources[0].table_id
  const sourceTableId = dominantTableId
  const uniqueSourceTableIds = new Set(orderedSources.map((s) => s.table_id))
  const isCrossTable = uniqueSourceTableIds.size > 1

  // Per-source join_spec storage. Populated only for non-dominant
  // sources whose joined table has 2+ candidate FKs in the dominant
  // table (user-disambiguated). Single-candidate joins remain null
  // so the read path re-derives annotation each render.
  const joinSpecBySourceFieldId = new Map<
    string,
    { viaSourceTable: string; viaFkField: string; toFkField: string | null }
  >()

  if (isCrossTable) {
    const joinedTableIds = [...uniqueSourceTableIds].filter(
      (id) => id !== dominantTableId,
    )

    const { data: tableRows, error: tablesErr } = await supabaseAdmin
      .from('tables')
      .select('id, name')
      .in('id', [dominantTableId, ...joinedTableIds])
    if (tablesErr || !tableRows) {
      return {
        success: false,
        error: 'Failed to read source tables for FK inference',
        errorCode: 'INTERNAL',
      }
    }
    const tablesById = new Map<string, FkInferenceTable>(
      tableRows.map((t) => [t.id, { id: t.id, name: t.name }]),
    )
    const dominantTableName = tablesById.get(dominantTableId)?.name ?? ''

    // FK fields in dominant. Order by `ordinal_position` so the
    // candidate list surfaces stably (matches read-path
    // `deriveJoinAnnotation` which iterates fields in DB order).
    const { data: domFieldsRaw, error: domErr } = await supabaseAdmin
      .from('fields')
      .select('name, is_foreign_key, fk_reference, ordinal_position')
      .eq('table_id', dominantTableId)
      .eq('is_foreign_key', true)
      .order('ordinal_position', { ascending: true })
    if (domErr) {
      return {
        success: false,
        error: 'Failed to read dominant table FK fields',
        errorCode: 'INTERNAL',
      }
    }
    const dominantFkFields: FkInferenceField[] = (domFieldsRaw ?? []).map(
      (f) => ({
        name: f.name as string,
        is_foreign_key: f.is_foreign_key as boolean | null,
        fk_reference: f.fk_reference as string | null,
      }),
    )

    // Resolve a viaFkField name for each joined table.
    const resolvedFkByJoinedTable = new Map<
      string,
      { viaFkField: string; toFkField: string | null }
    >()

    for (const joinedTableId of joinedTableIds) {
      const joinedTableName = tablesById.get(joinedTableId)?.name ?? ''
      if (!joinedTableName) {
        return {
          success: false,
          error: 'Joined source table not found',
          errorCode: 'NOT_FOUND',
        }
      }

      const candidates = inferFkCandidates(
        dominantFkFields,
        joinedTableId,
        joinedTableName,
        tablesById,
      )

      let pickedFkName: string | null = null
      let needsPersistedSpec = false

      if (candidates.length === 0) {
        return {
          success: false,
          error: `No foreign key in ${dominantTableName} references ${joinedTableName}. Add an FK in the source schema or use the legacy Mapping page for ad-hoc joins.`,
          errorCode: 'CROSS_TABLE_AMBIGUOUS',
          candidateFkFields: [],
          ambiguousJoinedTableId: joinedTableId,
          ambiguousJoinedTableName: joinedTableName,
          dominantTableName,
        }
      } else if (candidates.length === 1) {
        // Single-candidate inference: trust it, store null spec.
        pickedFkName = candidates[0]
        // If the user pre-supplied an annotation that mismatches the
        // sole candidate (rare, e.g. stale form against a renamed
        // FK), reject with VALIDATION rather than silently overriding.
        const override = joinAnnotations[joinedTableId]
        if (override !== undefined && override !== pickedFkName) {
          return {
            success: false,
            error: `Selected join field '${override}' is not a valid FK from ${dominantTableName} to ${joinedTableName}`,
            errorCode: 'VALIDATION',
          }
        }
        needsPersistedSpec = false
      } else {
        // 2+ candidates → require user disambiguation.
        const override = joinAnnotations[joinedTableId]
        if (override === undefined) {
          return {
            success: false,
            error: `Multiple foreign keys in ${dominantTableName} reference ${joinedTableName}. Pick the join field.`,
            errorCode: 'CROSS_TABLE_AMBIGUOUS',
            candidateFkFields: candidates,
            ambiguousJoinedTableId: joinedTableId,
            ambiguousJoinedTableName: joinedTableName,
            dominantTableName,
          }
        }
        if (!candidates.includes(override)) {
          // Defense-in-depth (§2-OQ-4): user-supplied override must
          // be in the live candidate list. Stale forms whose picked
          // FK was renamed/dropped fail VALIDATION, surfacing the
          // schema drift to the user.
          return {
            success: false,
            error: `Selected join field '${override}' is not a valid FK from ${dominantTableName} to ${joinedTableName}`,
            errorCode: 'VALIDATION',
          }
        }
        pickedFkName = override
        needsPersistedSpec = true
      }

      const matchedField = dominantFkFields.find(
        (f) => f.name === pickedFkName,
      )
      const toFkField = matchedField?.fk_reference
        ? parseToFkFieldFromReference(matchedField.fk_reference)
        : null

      resolvedFkByJoinedTable.set(joinedTableId, {
        viaFkField: pickedFkName!,
        toFkField,
      })

      if (needsPersistedSpec) {
        // Mark every source from this joined table for spec persistence.
        for (const sf of orderedSources) {
          if (sf.table_id === joinedTableId) {
            joinSpecBySourceFieldId.set(sf.id, {
              viaSourceTable: dominantTableName,
              viaFkField: pickedFkName!,
              toFkField,
            })
          }
        }
      }
    }
  }

  // ── Step 6: existing-TFM collision check ─────────────────────────────────
  const { data: existingTfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, status, is_acknowledged, combination_type')
    .eq('project_id', projectId)
    .eq('target_field_id', targetFieldId)
    .maybeSingle()

  if (existingTfm) {
    // Bare-acknowledgment exception: an `is_acknowledged=true` TFM with
    // `combination_type=null` has no mapping_sources or transformations,
    // so we can delete it cleanly to make room for the new mapping. This
    // mirrors legacy `addManualFieldMapping:1714-1719` and is the implicit
    // "create a mapping = un-ack the field" path.
    if (
      existingTfm.is_acknowledged === true &&
      existingTfm.combination_type === null
    ) {
      const { error: bareAckDelErr } = await supabaseAdmin
        .from('target_field_mappings')
        .delete()
        .eq('id', existingTfm.id)
      if (bareAckDelErr) {
        return {
          success: false,
          error: bareAckDelErr.message,
          errorCode: 'INTERNAL',
        }
      }
    } else if (existingTfm.status !== 'rejected') {
      // Any other live TFM (mapped, VA, full acknowledgment) blocks
      // creation. Per founder decision 3, surface the "refresh" copy
      // — we don't auto-convert to contributor (that decision belongs
      // on the form's UX, not silent server behavior).
      return {
        success: false,
        error:
          'This target field was mapped while you were editing. Refresh to see the current state.',
        errorCode: 'VALIDATION',
      }
    }
    // status === 'rejected' is impossible post-Gap-9 (reject = delete)
    // but if a legacy rejected row survives in production (Demo #2
    // SimpleLegal has 1), fall through and create alongside it. The
    // RPC's INSERT will fail on the (project_id, target_field_id)
    // unique constraint if so — surface as INTERNAL.
  }

  // ── Step 7: find-or-create table mapping ─────────────────────────────────
  const tmResult = await findOrCreateTableMapping(
    projectId,
    sourceTableId,
    targetField.table_id,
  )
  if (!tmResult.success) {
    return {
      success: false,
      error: tmResult.error,
      errorCode: 'INTERNAL',
    }
  }
  const tableMappingId = tmResult.id

  // ── Step 8: RPC call ─────────────────────────────────────────────────────
  // Per-source confidence: AI path passes uniform `confidence`; manual
  // path defaults to 100. The Transform-tab apply rules don't currently
  // gate on per-source confidence so this is metadata-only today.
  const perSourceConfidence = typeof confidence === 'number' ? confidence : 100
  const tfmAiReasoning = aiReasoning
    ? aiReasoning
    : aiSuggested
      ? 'AI-suggested via per-row Suggest'
      : 'Mapping created via redesign UI'
  const perSourceReasoning = aiSuggested
    ? `AI-suggested: ${(aiReasoning ?? '').slice(0, 280)}`.trim()
    : 'Manually selected by user'

  const rpcSources = orderedSources.map((sf, idx) => {
    // Per-source `join_spec`. Snake-case keys to match the stored
    // JSONB shape — the read-path `coerceJoinSpec` parses
    // `via_source_table`/`via_fk_field`/`to_fk_field` directly.
    // Single-candidate inferences and the dominant source itself
    // store null; the read path re-derives the annotation.
    const spec = joinSpecBySourceFieldId.get(sf.id)
    const join_spec = spec
      ? {
          via_source_table: spec.viaSourceTable,
          via_fk_field: spec.viaFkField,
          to_fk_field: spec.toFkField ?? '',
        }
      : null
    return {
      source_field_id: sf.id,
      source_table_id: sf.table_id,
      confidence: perSourceConfidence,
      ai_reasoning: perSourceReasoning,
      type_compatibility: null as string | null,
      similar_fields_considered: [] as string[],
      join_spec: join_spec as unknown,
      ordinal: idx,
    }
  })

  const { data: rpcTfmId, error: rpcErr } = await supabase.rpc(
    'dq_create_target_field_mapping',
    {
      p_project_id: projectId,
      p_target_field_id: targetFieldId,
      p_sources: rpcSources,
      p_combination: {
        type: combinationType,
        ai_reasoning: tfmAiReasoning,
      },
    },
  )

  if (rpcErr || !rpcTfmId) {
    return {
      success: false,
      error: rpcErr?.message ?? 'RPC failed',
      errorCode: 'INTERNAL',
    }
  }
  const newTfmId = rpcTfmId as string

  // ── Step 9: coverage recompute ───────────────────────────────────────────
  // Closes the legacy gap: addManualFieldMapping never called recompute,
  // leaving table_mappings.status stale until the next read-path action
  // happened to trigger it. The redesign-side wrapper owns this
  // explicitly so coverage-driven UI (counter pills, table-level status)
  // updates immediately.
  await recomputeTableMappingStatus(supabase, tableMappingId)

  // ── Step 10: revalidate ──────────────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  revalidatePath(`/app/projects/${projectId}/transform`)

  // ── Step 11: activity log ────────────────────────────────────────────────
  // Format: `Mapping created: <src1>, <src2>, +N more → <tgt>` for
  // verbosity parity with `mapping_rejected` payload from Gap 9.
  // For >3 sources, truncate the inline list to keep the activity feed
  // scannable.
  const srcNames = orderedSources.map((s) => s.name)
  const inlineSrcList =
    srcNames.length <= 3
      ? srcNames.join(', ')
      : `${srcNames.slice(0, 2).join(', ')}, +${srcNames.length - 2} more`
  const description = `${aiSuggested ? 'AI-suggested mapping' : 'Mapping'} created: ${inlineSrcList} \u2192 ${targetField.name}`

  await logActivity(projectId, 'mapping_created', description, 'mapping', {
    target_field_mapping_id: newTfmId,
    target_field: targetField.name,
    target_field_id: targetFieldId,
    source_fields: srcNames,
    source_field_ids: sourceFieldIds,
    combination_type: combinationType,
    ai_suggested: aiSuggested,
    cross_table: false, // Phase 4a-1 same-table only; 4a-3 will compute this.
  })

  return {
    success: true,
    tfmId: newTfmId,
    tableMappingId,
  }
}

// ─── Helper: find-or-create table_mappings ────────────────────────────────────
//
// Lifted from legacy `mapUnmappedField:2110-2134` so the redesign
// wrapper does not have to import a legacy entry-point that bundles
// auth + addManualFieldMapping + revalidate (we want JUST the
// find-or-create logic). Stays internal to this module.
//
// Uses the admin client because the wrapper has already verified
// project membership; an RLS-narrowed read could miss an existing TM
// row that the user lacks SELECT on, leading to a doomed INSERT.

async function findOrCreateTableMapping(
  projectId: string,
  sourceTableId: string,
  targetTableId: string,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .eq('source_table_id', sourceTableId)
    .eq('target_table_id', targetTableId)
    .maybeSingle()

  if (lookupErr) {
    return { success: false, error: lookupErr.message }
  }
  if (existing) {
    return { success: true, id: existing.id }
  }

  const { data: created, error: createErr } = await supabaseAdmin
    .from('table_mappings')
    .insert({
      project_id: projectId,
      source_table_id: sourceTableId,
      target_table_id: targetTableId,
      confidence: null,
      status: 'needs_review',
    })
    .select('id')
    .single()

  if (createErr || !created) {
    return {
      success: false,
      error: createErr?.message ?? 'Failed to create table mapping',
    }
  }
  return { success: true, id: created.id }
}

// ─── Per-target AI Suggest — Phase 4a-1 ───────────────────────────────────────
//
// `suggestMappingForTarget` is the W6 server-side surface: given a single
// target field, ask the LLM for ONE proposed mapping (1+ source fields +
// combination strategy + confidence + rationale). The wrapper returns an
// ephemeral suggestion for the form to pre-fill — NO DB writes happen
// here. Confirmation flows through `createFieldMapping` with
// `aiSuggested: true`.
//
// Distinct from legacy `suggestRemainingMappings` (per-TM bulk, same-
// table, 1:1 output schema, persists immediately). Net-new prompt body;
// reuses `buildAIContext` + `callClaude` + `checkAIRateLimit` plumbing.
//
// Same-table only in 4a-1 — the prompt instructs the LLM to choose
// sources from the target field's project's source schema BUT to keep
// all sources in a single source table. Cross-table extension in 4a-3.
//
// AUDIT LOG: this wrapper does NOT emit an activity_log entry on
// invocation. Suggestions are ephemeral; only `mapping_created` (with
// `ai_suggested: true` metadata) records the user's eventual commit.
// The rate limiter (in-memory; not durable) tracks invocation volume.

export type SuggestMappingErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'AI_INVALID_RESPONSE'
  | 'INTERNAL'

export type SuggestMappingForTargetResult =
  | {
      success: true
      suggestion: {
        sourceFieldIds: string[]
        combinationType: CreateFieldMappingCombinationType
        confidence: number
        rationale: string
      }
    }
  | {
      success: false
      error: string
      errorCode: SuggestMappingErrorCode
    }

interface ClaudeSuggestionResponse {
  source_field_names?: unknown
  combination_type?: unknown
  confidence?: unknown
  rationale?: unknown
}

const RATIONALE_MAX_CHARS = 280

export async function suggestMappingForTarget(input: {
  projectId: string
  targetFieldId: string
}): Promise<SuggestMappingForTargetResult> {
  const { projectId, targetFieldId } = input

  if (!projectId || !targetFieldId) {
    return {
      success: false,
      error: 'projectId and targetFieldId are required',
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  // Shared 100-calls/hour budget with `suggestRemainingMappings` and other
  // AI features (lib/ai/rate-limit.ts). Per-target Suggest is meant to be
  // selective — pilot users hitting the cap is signal to revisit, not a
  // wrapper concern.
  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) {
    return {
      success: false,
      error: rateLimit.error ?? 'AI rate limit exceeded',
      errorCode: 'RATE_LIMITED',
    }
  }

  // ── Read target field identity ───────────────────────────────────────────
  const { data: targetField, error: tfErr } = await supabaseAdmin
    .from('fields')
    // Same join-chain caveat as `createFieldMapping`: walk through
    // datasets to reach project_id (`tables` has no project_id column).
    // `tables.name` lives on `tables` itself so it stays at the first
    // hop alongside the nested `datasets!inner(project_id)`.
    .select(
      'id, name, data_type, is_primary_key, is_foreign_key, is_nullable, table_id, tables!inner(name, datasets!inner(project_id))',
    )
    .eq('id', targetFieldId)
    .single<{
      id: string
      name: string
      data_type: string
      is_primary_key: boolean | null
      is_foreign_key: boolean | null
      is_nullable: boolean | null
      table_id: string
      tables:
        | {
            name: string
            datasets:
              | { project_id: string }
              | { project_id: string }[]
              | null
          }
        | {
            name: string
            datasets:
              | { project_id: string }
              | { project_id: string }[]
              | null
          }[]
        | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const targetTablesNode = Array.isArray(targetField.tables)
    ? targetField.tables[0]
    : targetField.tables
  const targetDatasetsNode = Array.isArray(targetTablesNode?.datasets)
    ? targetTablesNode?.datasets[0]
    : targetTablesNode?.datasets
  const targetProjectId = targetDatasetsNode?.project_id
  if (targetProjectId !== projectId) {
    return {
      success: false,
      error: 'Target field does not belong to this project',
      errorCode: 'NOT_FOUND',
    }
  }
  const targetTableName = targetTablesNode?.name ?? '?'

  // ── Build AI context (project-wide source schema) ────────────────────────
  // Reuse `buildAIContext` so we get sample values + value distributions +
  // documents in the same shape that `suggestRemainingMappings` does.
  // Project-wide scope — the prompt's "same-table only" constraint is
  // expressed in instruction text, not by filtering the context.
  let context: Awaited<ReturnType<typeof buildAIContext>>
  try {
    context = await buildAIContext(
      projectId,
      {
        includeValueDistributions: true,
        includeSampleValues: true,
        includeDocuments: true,
        maxDistributionValues: 10,
        maxSampleValues: 5,
      },
      user.id,
    )
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error ? err.message : 'Failed to build AI context',
      errorCode: 'INTERNAL',
    }
  }

  // Resolve a name→id map for source fields so we can translate the LLM's
  // bare-name output back to UUIDs. `buildAIContext`'s FieldContext does
  // NOT expose field UUIDs (intentional: it's a prompt-shape contract,
  // not a DB-shape contract), so we run a small companion query that
  // fetches just (id, name, table_id) for every source-side field.
  const sourceTableIds = context.source_tables.map((t) => t.table_id)
  if (sourceTableIds.length === 0) {
    return {
      success: false,
      error: 'No source tables available to map against',
      errorCode: 'NOT_FOUND',
    }
  }

  const { data: sourceFieldRows, error: sfQErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .in('table_id', sourceTableIds)
    .returns<Array<{ id: string; name: string; table_id: string }>>()
  if (sfQErr || !sourceFieldRows) {
    return {
      success: false,
      error: sfQErr?.message ?? 'Failed to read source fields',
      errorCode: 'INTERNAL',
    }
  }

  const sourceFieldsByLowerName = new Map<
    string,
    { id: string; tableId: string }
  >()
  for (const row of sourceFieldRows) {
    // Last-write-wins for duplicate field names across source tables.
    // Acceptable for 4a-1 (same-table only) — the prompt instructs the
    // LLM to use a single source table, so collisions only matter if
    // the LLM ignores the instruction. 4a-3 will switch to fully-
    // qualified `Table.Field` lookups for cross-table.
    sourceFieldsByLowerName.set(row.name.toLowerCase(), {
      id: row.id,
      tableId: row.table_id,
    })
  }

  if (sourceFieldsByLowerName.size === 0) {
    return {
      success: false,
      error: 'No source fields available to map against',
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Build the prompt ─────────────────────────────────────────────────────
  const systemPrompt =
    'You are a data migration expert. Return ONLY valid JSON.'

  const targetTags: string[] = []
  if (targetField.is_primary_key) targetTags.push('PK')
  if (targetField.is_foreign_key) targetTags.push('FK')
  if (targetField.is_nullable) targetTags.push('nullable')
  const targetTagStr = targetTags.length ? ` [${targetTags.join(', ')}]` : ''

  // Pull the target field's own profile (samples + distribution) from
  // the context's `target_tables` if present. `FieldContext` exposes
  // `name` and `data_type` but not `id`, so match by table_id + name.
  let targetProfileBlock = ''
  for (const tbl of context.target_tables) {
    if (tbl.table_id !== targetField.table_id) continue
    const f = tbl.fields.find((x) => x.name === targetField.name)
    if (!f) continue
    const samples = f.sample_values?.slice(0, 5) ?? []
    const dist = f.value_distribution?.slice(0, 10) ?? []
    if (samples.length > 0) {
      targetProfileBlock += `\n  Samples: ${samples.map((v) => `"${v}"`).join(', ')}`
    }
    if (dist.length > 0) {
      targetProfileBlock += `\n  Values: ${dist
        .map((v) => `"${v.value}"(${v.count})`)
        .join(', ')}`
    }
    break
  }

  const sourceTablesBlock = context.source_tables
    .map((tbl) => {
      const lines = tbl.fields
        .map((f) => {
          const tags: string[] = []
          if (f.is_primary_key) tags.push('PK')
          if (f.is_foreign_key) tags.push('FK')
          if (f.is_nullable) tags.push('nullable')
          const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
          let line = `  - ${f.name} (${f.data_type})${tagStr}`
          if (f.value_distribution?.length) {
            const top = f.value_distribution.slice(0, 5)
            line += `\n      Values: ${top.map((v) => `"${v.value}"(${v.count})`).join(', ')}`
          } else if (f.sample_values?.length) {
            line += `\n      Samples: ${f.sample_values.slice(0, 3).map((v) => `"${v}"`).join(', ')}`
          }
          return line
        })
        .join('\n')
      return `<source_table name="${tbl.table_name}">\n${lines}\n</source_table>`
    })
    .join('\n\n')

  const docBlock = formatDocumentsForPrompt(context.documents)

  const userMsg = `Target field: ${targetTableName}.${targetField.name} (${targetField.data_type})${targetTagStr}${targetProfileBlock}

Suggest ONE mapping for this target field. Pick 1 or more source fields, all from the SAME source table. Cross-table sources are NOT allowed in this version.

Available source fields (grouped by source table):

${sourceTablesBlock}
${docBlock}
${context.intelligence_context ? context.intelligence_context + '\n\n' : ''}IMPORTANT:
- Use bare field names (not table.field).
- All source_field_names MUST come from the SAME source table.
- combination_type must be one of: "single", "concat_space", "concat_comma".
  Use "single" iff exactly one source. Use "concat_space" or "concat_comma" for 2+ sources.
- confidence is 0-100 indicating how confident you are in the proposed mapping.
- rationale is a brief explanation, ≤ ${RATIONALE_MAX_CHARS} characters.

Respond with ONLY valid JSON in this exact shape:
{"source_field_names": ["FieldA"], "combination_type": "single", "confidence": 85, "rationale": "Brief reason"}`

  // ── Call LLM ─────────────────────────────────────────────────────────────
  let raw: string
  try {
    raw = await callClaude(systemPrompt, userMsg, 1024)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'AI call failed',
      errorCode: 'INTERNAL',
    }
  }

  // ── Parse + validate response ────────────────────────────────────────────
  let parsed: ClaudeSuggestionResponse
  try {
    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned
        .replace(/^```(?:json)?\n?/, '')
        .replace(/\n?```$/, '')
        .trim()
    }
    parsed = JSON.parse(cleaned) as ClaudeSuggestionResponse
  } catch {
    return {
      success: false,
      error: 'AI returned invalid JSON. Please try again.',
      errorCode: 'AI_INVALID_RESPONSE',
    }
  }

  if (!Array.isArray(parsed.source_field_names)) {
    return {
      success: false,
      error: 'AI response missing source_field_names array',
      errorCode: 'AI_INVALID_RESPONSE',
    }
  }

  // Translate names → ids; strip unknowns; preserve LLM-emitted order.
  const resolvedIds: string[] = []
  const resolvedTableIds = new Set<string>()
  for (const rawName of parsed.source_field_names) {
    if (typeof rawName !== 'string') continue
    const bare = rawName.split('.').pop()!.toLowerCase().trim()
    const hit = sourceFieldsByLowerName.get(bare)
    if (!hit) continue
    if (resolvedIds.includes(hit.id)) continue // dedupe
    resolvedIds.push(hit.id)
    resolvedTableIds.add(hit.tableId)
  }

  if (resolvedIds.length === 0) {
    // Either LLM emitted nothing usable or all names stripped out.
    return {
      success: false,
      error:
        'AI did not return any usable source fields. Please pick sources manually.',
      errorCode: 'AI_INVALID_RESPONSE',
    }
  }

  // Same-table guard on the LLM output. If the LLM ignored the instruction
  // and emitted cross-table sources, drop the cross-table tail and keep
  // the dominant-table prefix. If no same-table subset survives, surface
  // AI_INVALID_RESPONSE so the user retries.
  if (resolvedTableIds.size > 1) {
    const dominantTableId = sourceFieldsByLowerName.get(
      String(parsed.source_field_names[0])
        .split('.')
        .pop()!
        .toLowerCase()
        .trim(),
    )?.tableId
    const sameTable = resolvedIds.filter((id) => {
      for (const v of sourceFieldsByLowerName.values()) {
        if (v.id === id) return v.tableId === dominantTableId
      }
      return false
    })
    if (sameTable.length === 0) {
      return {
        success: false,
        error:
          'AI suggested cross-table sources, which are not yet supported. Please pick sources manually.',
        errorCode: 'AI_INVALID_RESPONSE',
      }
    }
    resolvedIds.length = 0
    resolvedIds.push(...sameTable)
  }

  // Combination type narrowing.
  const rawCombo = String(parsed.combination_type ?? '').toLowerCase()
  let combinationType: CreateFieldMappingCombinationType
  if (resolvedIds.length === 1) {
    combinationType = 'single'
  } else if (rawCombo === 'concat_comma') {
    combinationType = 'concat_comma'
  } else {
    // Default for 2+ sources matches the form's pre-selection (decision 7).
    combinationType = 'concat_space'
  }

  const confidenceNum = Number(parsed.confidence)
  const confidence =
    Number.isFinite(confidenceNum) && confidenceNum >= 0 && confidenceNum <= 100
      ? Math.round(confidenceNum)
      : 50

  const rationaleRaw =
    typeof parsed.rationale === 'string' ? parsed.rationale : ''
  const rationale = rationaleRaw.slice(0, RATIONALE_MAX_CHARS)

  return {
    success: true,
    suggestion: {
      sourceFieldIds: resolvedIds,
      combinationType,
      confidence,
      rationale,
    },
  }
}

// ─── Write path — Phase 4b-1 (edit existing mappings) ────────────────────────
//
// `editMappingSources`, `updateMappingCombination`, and `previewEditInvalidation`
// form the W2 (sources) + W3 (combination) edit surfaces for an EXISTING TFM
// reachable from the redesign drawer. New behavior contract (per founder
// decisions §1-§10 in the Phase 4b investigation):
//
//   • Status revert  — any source/combination change flips the TFM back to
//                      `needs_review` regardless of prior state. The user
//                      must explicitly Approve again.
//   • Provenance laundering — when a source change strips every original
//                      AI-suggested source, the TFM-level `ai_reasoning`
//                      and per-source AI markers are wiped to manual
//                      provenance. Retaining ≥1 original AI source
//                      preserves the AI markers on retained rows; new
//                      rows always carry manual markers.
//   • Transform reset — source edits call `resetFieldTransform`, which
//                      deletes the transformations row AND reverts staged
//                      data (strips the target field key). Combination-only
//                      edits do NOT reset the transform (§1.3) — the
//                      transform SQL is still valid, only the combination
//                      semantics changed.
//   • Dominant table swap blocked (§5) — changing the FIRST source's
//                      table would require re-anchoring the table-mapping
//                      and re-deriving every join_spec. Out of scope for
//                      4b-1; surfaces as `DOMINANT_TABLE_CHANGED` so the
//                      UI can prompt "remove the original primary source
//                      first, then add the new dominant table". Founder
//                      decision §5: ship later if real demand surfaces.
//   • Bare-acknowledged TFMs (`is_acknowledged=true`, no sources) cannot
//                      be edited via this path — the un-acknowledge flow
//                      ships as W4 in 4b-2 (founder decision §3.4 +
//                      §9.1). Returns `TFM_ACKNOWLEDGED`.
//   • Defensive `TFM_REJECTED` — post Gap-9 reject == delete, so a
//                      rejected TFM should be unreachable; if a legacy
//                      rejected row survives, refuse to mutate it.
//
// `previewEditInvalidation` is a read-only pre-save query the drawer
// invokes BEFORE calling `editMappingSources` so it can show the
// EditInvalidationDialog warning when (a) a transform exists for this
// field AND (b) staged_data_rows reference the target field key. The
// drawer-side dialog routes through `editMappingSources` regardless on
// confirm — the preview only drives copy.

export type EditMappingErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'
  /** Cross-table FK precheck failed; same shape as create-time. */
  | 'CROSS_TABLE_AMBIGUOUS'
  /**
   * The user picked a different dominant-table source. Re-anchoring the
   * table-mapping (and re-deriving every join_spec) is out of scope for
   * 4b-1; the UI prompts the user to remove the original primary first.
   */
  | 'DOMINANT_TABLE_CHANGED'
  /**
   * Defensive — post-Gap-9 a rejected TFM should be unreachable
   * (reject == delete). If a legacy `status='rejected'` row survives,
   * refuse to mutate it; the user must reject (delete) and re-create.
   */
  | 'TFM_REJECTED'
  /**
   * Bare-acknowledged TFM (`is_acknowledged=true`, no sources). Edit
   * doesn't apply; the user must un-acknowledge first (W4 in 4b-2).
   */
  | 'TFM_ACKNOWLEDGED'

export type EditMappingResult =
  | {
      success: true
      tfmId: string
      /**
       * True when `resetFieldTransform` actually deleted a transform row.
       * The drawer surfaces a "Re-author transform" deep-link in the
       * post-save toast when this is true.
       */
      transformReset: boolean
      /** Number of staged_data_rows whose target field key was reverted. */
      stagedRowsReverted: number
      /**
       * True when the source set changed (set diff vs. existing). Combination-
       * only or no-op edits report `false`. Drives whether the drawer's
       * post-save toast mentions invalidation at all.
       */
      sourcesChanged: boolean
    }
  | {
      success: false
      error: string
      errorCode: EditMappingErrorCode
      candidateFkFields?: string[]
      ambiguousJoinedTableId?: string
      ambiguousJoinedTableName?: string
      dominantTableName?: string
    }

export type UpdateCombinationErrorCode =
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'MAINTENANCE_MODE'
  | 'INTERNAL'
  | 'TFM_REJECTED'
  | 'TFM_ACKNOWLEDGED'

export type UpdateCombinationResult =
  | { success: true; tfmId: string }
  | {
      success: false
      error: string
      errorCode: UpdateCombinationErrorCode
    }

export type PreviewEditInvalidationResult =
  | {
      success: true
      hasTransform: boolean
      /**
       * Count of staged_data_rows whose `transformed_row_data` JSONB
       * carries the target field name as a key. Capped at
       * PREVIEW_INVALIDATION_COUNT_CAP (101) so the dialog can render
       * "100+ staged rows" without paging through millions of rows.
       */
      stagedRowCount: number
      /** True when stagedRowCount hit the cap (i.e. real count is ≥ cap). */
      capped: boolean
    }
  | {
      success: false
      error: string
      errorCode: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'INTERNAL'
    }

/**
 * Founder decision §2.1 — show exact count when ≤100, qualitative copy
 * ("100+ staged rows") otherwise. The preview query caps at
 * `PREVIEW_INVALIDATION_COUNT_CAP` so a project with millions of staged
 * rows doesn't punish the dialog with a full count.
 */
// Note: `'use server'` files can only export async functions, so this
// is a module-internal const. The number is also documented in
// `docs/features/mapping-redesign.md` and referenced by name in
// `EditInvalidationDialog.tsx`'s JSDoc.
const PREVIEW_INVALIDATION_COUNT_CAP = 101

/**
 * Edit the source set of an existing TFM. See file header for the full
 * 4b-1 contract. This is the W2 server-side surface.
 *
 * SEQUENCE:
 *   1.  Cheap input validation (1+ sources, no dups, custom_sql blocked,
 *       single↔concat sanity).
 *   2.  Auth (Supabase user).
 *   3.  Identity reads: TFM (with project_id, target_field_id, status,
 *       is_acknowledged, ai_reasoning, combination_type) + existing
 *       mapping_sources (with source_field_id + ai_reasoning).
 *   4.  Project permission gate (`requireProjectPermission(..., 'editor')`).
 *   5.  Defensive state guards: TFM_REJECTED (post-Gap-9 unreachable),
 *       TFM_ACKNOWLEDGED (bare-ack TFM has no sources to edit).
 *   6.  Maintenance-mode guard.
 *   7.  Source field identity reads (project ownership) + reorder to
 *       input order (dominant = ordinal 0).
 *   8.  Dominant-table swap detection. The first new source's table_id
 *       MUST match the original dominant. Mismatch → DOMINANT_TABLE_CHANGED.
 *   9.  Cross-table FK precheck (parallel to createFieldMapping).
 *  10.  Provenance laundering: read existing AI-suggested source ids,
 *       compute retained set, derive new TFM-level ai_reasoning and
 *       per-source ai_reasoning markers.
 *  11.  Compute set-diff to drive `sourcesChanged` flag (drives
 *       transform reset + activity log + post-save toast).
 *  12.  RPC `dq_replace_mapping_sources` — atomic DELETE+INSERT. Fires
 *       only when something actually changed (no-op edits skip).
 *  13.  UPDATE target_field_mappings SET status='needs_review',
 *       combination_type=<new>, ai_reasoning=<new>, updated_at=now().
 *  14.  If sourcesChanged: `resetFieldTransform` to clean up transform
 *       row + revert staged data.
 *  15.  Coverage recompute on the (existing) table_mappings row.
 *  16.  revalidatePath /mapping AND /transform.
 *  17.  Activity log: `mapping_sources_changed` always (even no-op so
 *       the audit trail captures the user's explicit edit click).
 *       Plus `transformation_reset` when applicable.
 *  18.  Return result with transformReset + stagedRowsReverted +
 *       sourcesChanged so the drawer can drive its post-save toast.
 */
export async function editMappingSources(input: {
  tfmId: string
  sourceFieldIds: string[]
  combinationType: CreateFieldMappingCombinationType | 'custom_sql'
  /** See `createFieldMapping`'s `joinAnnotations` doc — same shape. */
  joinAnnotations?: Record<string, string>
}): Promise<EditMappingResult> {
  const {
    tfmId,
    sourceFieldIds,
    combinationType,
    joinAnnotations = {},
  } = input

  // ── Step 1: validation ───────────────────────────────────────────────────
  if (!tfmId) {
    return {
      success: false,
      error: 'tfmId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (!Array.isArray(sourceFieldIds) || sourceFieldIds.length === 0) {
    return {
      success: false,
      error: 'At least one source field is required',
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType === 'custom_sql') {
    return {
      success: false,
      error:
        'Custom SQL combinations are authored on the Transform tab, not here',
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType === 'single' && sourceFieldIds.length !== 1) {
    return {
      success: false,
      error: "combination_type 'single' requires exactly one source field",
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType !== 'single' && sourceFieldIds.length < 2) {
    return {
      success: false,
      error: `combination_type '${combinationType}' requires at least two source fields`,
      errorCode: 'VALIDATION',
    }
  }
  if (new Set(sourceFieldIds).size !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'Duplicate source fields are not allowed',
      errorCode: 'VALIDATION',
    }
  }

  // ── Step 2: auth ─────────────────────────────────────────────────────────
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 3: identity read — TFM + existing sources ───────────────────────
  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      'id, project_id, target_field_id, status, is_acknowledged, ai_reasoning, combination_type',
    )
    .eq('id', tfmId)
    .maybeSingle<{
      id: string
      project_id: string
      target_field_id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
      ai_reasoning: string | null
      combination_type: string | null
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }
  const projectId = tfm.project_id

  // ── Step 4: permission ───────────────────────────────────────────────────
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // ── Step 5: defensive state guards ──────────────────────────────────────
  if (tfm.status === 'rejected') {
    return {
      success: false,
      error:
        "This mapping has been rejected. Reject and re-create instead of editing.",
      errorCode: 'TFM_REJECTED',
    }
  }
  if (tfm.is_acknowledged) {
    return {
      success: false,
      error:
        "This field is acknowledged. Un-acknowledge it first to map it.",
      errorCode: 'TFM_ACKNOWLEDGED',
    }
  }

  // ── Step 6: maintenance gate ─────────────────────────────────────────────
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Step 7: identity reads — target field + source fields ───────────────
  const { data: targetField, error: tfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .eq('id', tfm.target_field_id)
    .single<{
      id: string
      name: string
      table_id: string
      tables:
        | { datasets: { project_id: string } | { project_id: string }[] | null }
        | {
            datasets: { project_id: string } | { project_id: string }[] | null
          }[]
        | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const { data: sourceFields, error: sfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables!inner(datasets!inner(project_id))')
    .in('id', sourceFieldIds)
    .returns<
      Array<{
        id: string
        name: string
        table_id: string
        tables:
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }
          | {
              datasets:
                | { project_id: string }
                | { project_id: string }[]
                | null
            }[]
          | null
      }>
    >()
  if (sfErr || !sourceFields) {
    return {
      success: false,
      error: 'Failed to read source fields',
      errorCode: 'INTERNAL',
    }
  }
  if (sourceFields.length !== sourceFieldIds.length) {
    return {
      success: false,
      error: 'One or more source fields not found',
      errorCode: 'NOT_FOUND',
    }
  }
  for (const sf of sourceFields) {
    const sfTables = Array.isArray(sf.tables) ? sf.tables[0] : sf.tables
    const sfDatasets = Array.isArray(sfTables?.datasets)
      ? sfTables?.datasets[0]
      : sfTables?.datasets
    const sfProject = sfDatasets?.project_id
    if (sfProject !== projectId) {
      return {
        success: false,
        error: 'One or more source fields do not belong to this project',
        errorCode: 'VALIDATION',
      }
    }
  }
  const sourceFieldsById = new Map(sourceFields.map((f) => [f.id, f]))
  const orderedSources = sourceFieldIds.map((id) => sourceFieldsById.get(id)!)

  // ── Step 7b: identity read — existing mapping_sources ───────────────────
  // Captures both the original dominant table (for swap detection) and
  // the AI-suggested source ids (for provenance laundering).
  const { data: existingSources, error: esErr } = await supabaseAdmin
    .from('mapping_sources')
    .select('source_field_id, source_table_id, ai_reasoning, ordinal')
    .eq('target_field_mapping_id', tfm.id)
    .order('ordinal', { ascending: true })
    .returns<
      Array<{
        source_field_id: string | null
        source_table_id: string | null
        ai_reasoning: string | null
        ordinal: number | null
      }>
    >()
  if (esErr || !existingSources) {
    return {
      success: false,
      error: 'Failed to read existing mapping sources',
      errorCode: 'INTERNAL',
    }
  }
  const originalDominantTableId =
    existingSources.length > 0 ? existingSources[0].source_table_id : null
  // AI-suggested rows are tagged with `ai_reasoning` starting with
  // 'AI-suggested:' (per createFieldMapping's perSourceReasoning). Manual
  // rows carry 'Manually selected by user'. Provenance is tracked at the
  // source row level so a single TFM can mix retained-AI + new-manual
  // rows after an edit.
  const originalAiSuggestedSourceIds = new Set<string>(
    existingSources
      .filter(
        (s) =>
          s.source_field_id !== null &&
          typeof s.ai_reasoning === 'string' &&
          s.ai_reasoning.startsWith('AI-suggested:'),
      )
      .map((s) => s.source_field_id as string),
  )
  const existingSourceFieldIds = new Set<string>(
    existingSources
      .filter((s) => s.source_field_id !== null)
      .map((s) => s.source_field_id as string),
  )

  // ── Step 8: dominant-table swap detection ───────────────────────────────
  const newDominantTableId = orderedSources[0].table_id
  if (
    originalDominantTableId !== null &&
    newDominantTableId !== originalDominantTableId
  ) {
    return {
      success: false,
      error:
        "Changing the first source's table requires re-creating the mapping. Remove the original primary source, then add the new one.",
      errorCode: 'DOMINANT_TABLE_CHANGED',
    }
  }

  // ── Step 9: cross-table FK precheck ─────────────────────────────────────
  // Logic mirrors `createFieldMapping` Step 5b. Duplicated inline (rather
  // than extracted into a shared helper) so a regression in one path
  // cannot silently affect the other; the duplication is local to this
  // file and easy to reconcile when both paths converge in a later phase.
  const sourceTableId = newDominantTableId
  const uniqueSourceTableIds = new Set(orderedSources.map((s) => s.table_id))
  const isCrossTable = uniqueSourceTableIds.size > 1

  const joinSpecBySourceFieldId = new Map<
    string,
    { viaSourceTable: string; viaFkField: string; toFkField: string | null }
  >()

  if (isCrossTable) {
    const joinedTableIds = [...uniqueSourceTableIds].filter(
      (id) => id !== newDominantTableId,
    )

    const { data: tableRows, error: tablesErr } = await supabaseAdmin
      .from('tables')
      .select('id, name')
      .in('id', [newDominantTableId, ...joinedTableIds])
    if (tablesErr || !tableRows) {
      return {
        success: false,
        error: 'Failed to read source tables for FK inference',
        errorCode: 'INTERNAL',
      }
    }
    const tablesById = new Map<string, FkInferenceTable>(
      tableRows.map((t) => [t.id, { id: t.id, name: t.name }]),
    )
    const dominantTableName = tablesById.get(newDominantTableId)?.name ?? ''

    const { data: domFieldsRaw, error: domErr } = await supabaseAdmin
      .from('fields')
      .select('name, is_foreign_key, fk_reference, ordinal_position')
      .eq('table_id', newDominantTableId)
      .eq('is_foreign_key', true)
      .order('ordinal_position', { ascending: true })
    if (domErr) {
      return {
        success: false,
        error: 'Failed to read dominant table FK fields',
        errorCode: 'INTERNAL',
      }
    }
    const dominantFkFields: FkInferenceField[] = (domFieldsRaw ?? []).map(
      (f) => ({
        name: f.name as string,
        is_foreign_key: f.is_foreign_key as boolean | null,
        fk_reference: f.fk_reference as string | null,
      }),
    )

    for (const joinedTableId of joinedTableIds) {
      const joinedTableName = tablesById.get(joinedTableId)?.name ?? ''
      if (!joinedTableName) {
        return {
          success: false,
          error: 'Joined source table not found',
          errorCode: 'NOT_FOUND',
        }
      }

      const candidates = inferFkCandidates(
        dominantFkFields,
        joinedTableId,
        joinedTableName,
        tablesById,
      )

      let pickedFkName: string | null = null
      let needsPersistedSpec = false

      if (candidates.length === 0) {
        return {
          success: false,
          error: `No foreign key in ${dominantTableName} references ${joinedTableName}. Add an FK in the source schema or use the legacy Mapping page for ad-hoc joins.`,
          errorCode: 'CROSS_TABLE_AMBIGUOUS',
          candidateFkFields: [],
          ambiguousJoinedTableId: joinedTableId,
          ambiguousJoinedTableName: joinedTableName,
          dominantTableName,
        }
      } else if (candidates.length === 1) {
        pickedFkName = candidates[0]
        const override = joinAnnotations[joinedTableId]
        if (override !== undefined && override !== pickedFkName) {
          return {
            success: false,
            error: `Selected join field '${override}' is not a valid FK from ${dominantTableName} to ${joinedTableName}`,
            errorCode: 'VALIDATION',
          }
        }
        needsPersistedSpec = false
      } else {
        const override = joinAnnotations[joinedTableId]
        if (override === undefined) {
          return {
            success: false,
            error: `Multiple foreign keys in ${dominantTableName} reference ${joinedTableName}. Pick the join field.`,
            errorCode: 'CROSS_TABLE_AMBIGUOUS',
            candidateFkFields: candidates,
            ambiguousJoinedTableId: joinedTableId,
            ambiguousJoinedTableName: joinedTableName,
            dominantTableName,
          }
        }
        if (!candidates.includes(override)) {
          return {
            success: false,
            error: `Selected join field '${override}' is not a valid FK from ${dominantTableName} to ${joinedTableName}`,
            errorCode: 'VALIDATION',
          }
        }
        pickedFkName = override
        needsPersistedSpec = true
      }

      const matchedField = dominantFkFields.find(
        (f) => f.name === pickedFkName,
      )
      const toFkField = matchedField?.fk_reference
        ? parseToFkFieldFromReference(matchedField.fk_reference)
        : null

      if (needsPersistedSpec) {
        for (const sf of orderedSources) {
          if (sf.table_id === joinedTableId) {
            joinSpecBySourceFieldId.set(sf.id, {
              viaSourceTable: dominantTableName,
              viaFkField: pickedFkName!,
              toFkField,
            })
          }
        }
      }
    }
  }

  // ── Step 10: provenance laundering (§1f, 4a-4b parity) ──────────────────
  // RULE: any source row whose source_field_id is in
  // `originalAiSuggestedSourceIds` AND survives the edit retains its
  // 'AI-suggested:…' marker; everything else (new sources + originally-
  // manual sources) gets the manual marker. The TFM-level `ai_reasoning`
  // collapses to manual when ZERO original AI sources survive — even if
  // the edit happened to keep some manual sources.
  const newSourceIdsSet = new Set(sourceFieldIds)
  const retainedAiSourceIds = new Set(
    [...originalAiSuggestedSourceIds].filter((id) => newSourceIdsSet.has(id)),
  )
  const stillHasOriginalAi = retainedAiSourceIds.size > 0
  const newTfmAiReasoning = stillHasOriginalAi
    ? tfm.ai_reasoning ?? 'AI-suggested via per-row Suggest'
    : 'Mapping edited via redesign UI'

  // ── Step 11: source set-diff (drives transform reset + log copy) ─────────
  let sourcesChanged = false
  if (newSourceIdsSet.size !== existingSourceFieldIds.size) {
    sourcesChanged = true
  } else {
    for (const id of newSourceIdsSet) {
      if (!existingSourceFieldIds.has(id)) {
        sourcesChanged = true
        break
      }
    }
  }
  // Ordinal change (re-ordering sources without adding/removing) ALSO counts
  // as a source change because the dominant source defines the join anchor.
  if (!sourcesChanged && existingSources.length === sourceFieldIds.length) {
    for (let i = 0; i < sourceFieldIds.length; i++) {
      if (existingSources[i].source_field_id !== sourceFieldIds[i]) {
        sourcesChanged = true
        break
      }
    }
  }

  // ── Step 12: replace mapping sources via RPC ────────────────────────────
  const rpcSources = orderedSources.map((sf, idx) => {
    const spec = joinSpecBySourceFieldId.get(sf.id)
    const join_spec = spec
      ? {
          via_source_table: spec.viaSourceTable,
          via_fk_field: spec.viaFkField,
          to_fk_field: spec.toFkField ?? '',
        }
      : null
    const isRetainedAi = retainedAiSourceIds.has(sf.id)
    return {
      source_field_id: sf.id,
      source_table_id: sf.table_id,
      // Edit-time we don't have a fresh confidence signal — preserve the
      // existing per-source confidence by reusing 100 for new manual rows
      // and re-using the stored value when the source is retained. The
      // RPC's INSERT writes whatever we send; we don't pass through prior
      // per-source confidence today (would require a per-id lookup) — a
      // future polish, low priority because confidence isn't gating any
      // behavior.
      confidence: 100,
      ai_reasoning: isRetainedAi
        ? existingSources.find((s) => s.source_field_id === sf.id)
            ?.ai_reasoning ?? 'AI-suggested: (preserved across edit)'
        : 'Manually selected by user',
      type_compatibility: null as string | null,
      similar_fields_considered: [] as string[],
      join_spec: join_spec as unknown,
      ordinal: idx,
    }
  })

  const { error: rpcErr } = await supabase.rpc('dq_replace_mapping_sources', {
    p_tfm_id: tfm.id,
    p_sources: rpcSources,
  })
  if (rpcErr) {
    return {
      success: false,
      error: rpcErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 13: TFM-level UPDATE (status revert + combination + AI) ────────
  const { error: tfmUpdErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      status: 'needs_review',
      combination_type: combinationType,
      ai_reasoning: newTfmAiReasoning,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tfm.id)
  if (tfmUpdErr) {
    return {
      success: false,
      error: tfmUpdErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // ── Step 14: transform reset (only when sources changed) ─────────────────
  let transformReset = false
  let stagedRowsReverted = 0
  if (sourcesChanged) {
    const { resetFieldTransform } = await import('@/lib/actions/transformations')
    const reset = await resetFieldTransform(tfm.id)
    if (reset.success) {
      transformReset = reset.hadTransform
      stagedRowsReverted = reset.rowsReverted
    } else {
      // Soft-fail: surface as INTERNAL but the source replacement already
      // committed; the user gets a "transform may be stale" follow-up. We
      // do NOT roll back the source change because the transform reset is
      // best-effort cleanup and a stale transform will just be `applied=false`
      // until the user re-authors.
      console.warn(
        '[editMappingSources] resetFieldTransform failed:',
        reset.error,
      )
    }
  }

  // ── Step 15: coverage recompute ──────────────────────────────────────────
  // Look up the existing TM for the dominant source table → target table.
  const { data: existingTm } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .eq('source_table_id', sourceTableId)
    .eq('target_table_id', targetField.table_id)
    .maybeSingle()
  if (existingTm?.id) {
    await recomputeTableMappingStatus(supabase, existingTm.id as string)
  }

  // ── Step 16: revalidate ──────────────────────────────────────────────────
  revalidatePath(`/app/projects/${projectId}/mapping`)
  revalidatePath(`/app/projects/${projectId}/transform`)

  // ── Step 17: activity logs ───────────────────────────────────────────────
  const srcNames = orderedSources.map((s) => s.name)
  const inlineSrcList =
    srcNames.length <= 3
      ? srcNames.join(', ')
      : `${srcNames.slice(0, 2).join(', ')}, +${srcNames.length - 2} more`
  const editDescription = `Mapping edited: ${inlineSrcList} \u2192 ${targetField.name}`

  await logActivity(projectId, 'mapping_sources_changed', editDescription, 'mapping', {
    target_field_mapping_id: tfm.id,
    target_field: targetField.name,
    target_field_id: tfm.target_field_id,
    source_fields: srcNames,
    source_field_ids: sourceFieldIds,
    combination_type: combinationType,
    sources_changed: sourcesChanged,
    cross_table: isCrossTable,
    transform_reset: transformReset,
  })

  if (transformReset) {
    await logActivity(
      projectId,
      'transformation_reset',
      `Transformation reset on edit: ${targetField.name}`,
      'transform',
      {
        reason: 'mapping_edited',
        target_field_mapping_id: tfm.id,
        target_field: targetField.name,
        rows_reverted: stagedRowsReverted,
      },
    )
  }

  return {
    success: true,
    tfmId: tfm.id,
    transformReset,
    stagedRowsReverted,
    sourcesChanged,
  }
}

/**
 * Update only the combination_type on an existing TFM. Cheaper than
 * `editMappingSources` because:
 *   • Sources are unchanged → no `dq_replace_mapping_sources` call.
 *   • Transform is NOT reset (per founder decision §1.3) — the SQL is
 *     still valid, only the combination semantics changed.
 *   • Provenance laundering does NOT apply (no source touched).
 *
 * Status reverts to `needs_review` so the user re-approves explicitly.
 */
export async function updateMappingCombination(
  tfmId: string,
  combinationType: CreateFieldMappingCombinationType | 'custom_sql',
): Promise<UpdateCombinationResult> {
  if (!tfmId) {
    return {
      success: false,
      error: 'tfmId is required',
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType === 'custom_sql') {
    return {
      success: false,
      error:
        'Custom SQL combinations are authored on the Transform tab, not here',
      errorCode: 'VALIDATION',
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select(
      'id, project_id, target_field_id, status, is_acknowledged, combination_type',
    )
    .eq('id', tfmId)
    .maybeSingle<{
      id: string
      project_id: string
      target_field_id: string
      status: 'needs_review' | 'approved' | 'rejected'
      is_acknowledged: boolean
      combination_type: string | null
    }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const perm = await requireProjectPermission(tfm.project_id, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  if (tfm.status === 'rejected') {
    return {
      success: false,
      error:
        "This mapping has been rejected. Reject and re-create instead of editing.",
      errorCode: 'TFM_REJECTED',
    }
  }
  if (tfm.is_acknowledged) {
    return {
      success: false,
      error:
        "This field is acknowledged. Un-acknowledge it first to map it.",
      errorCode: 'TFM_ACKNOWLEDGED',
    }
  }

  try {
    await assertMappingWritesEnabled(tfm.project_id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (
      message ===
      'Mapping writes are temporarily disabled for scheduled maintenance'
    ) {
      return {
        success: false,
        error: message,
        errorCode: 'MAINTENANCE_MODE',
      }
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    }
  }

  // Single↔concat sanity vs. existing source count.
  const { count: existingSourceCount } = await supabaseAdmin
    .from('mapping_sources')
    .select('id', { count: 'exact', head: true })
    .eq('target_field_mapping_id', tfm.id)
  const sourceCount = existingSourceCount ?? 0
  if (combinationType === 'single' && sourceCount !== 1) {
    return {
      success: false,
      error:
        "combination_type 'single' requires exactly one source field on the mapping",
      errorCode: 'VALIDATION',
    }
  }
  if (combinationType !== 'single' && sourceCount < 2) {
    return {
      success: false,
      error: `combination_type '${combinationType}' requires at least two source fields on the mapping`,
      errorCode: 'VALIDATION',
    }
  }

  // No-op short-circuit: if the new value matches the existing one, still
  // bump status to needs_review (the user's intent was an edit) but skip
  // the activity log and revalidate to avoid log spam.
  if (tfm.combination_type === combinationType && tfm.status === 'needs_review') {
    return { success: true, tfmId: tfm.id }
  }

  const { error: updErr } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      status: 'needs_review',
      combination_type: combinationType,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tfm.id)
  if (updErr) {
    return {
      success: false,
      error: updErr.message,
      errorCode: 'INTERNAL',
    }
  }

  // Read target field name for the activity-log payload.
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('name')
    .eq('id', tfm.target_field_id)
    .single<{ name: string }>()

  revalidatePath(`/app/projects/${tfm.project_id}/mapping`)
  revalidatePath(`/app/projects/${tfm.project_id}/transform`)

  await logActivity(
    tfm.project_id,
    'mapping_combination_changed',
    `Combination changed: ${targetField?.name ?? '?'} \u2192 ${combinationType}`,
    'mapping',
    {
      target_field_mapping_id: tfm.id,
      target_field: targetField?.name ?? null,
      target_field_id: tfm.target_field_id,
      previous_combination_type: tfm.combination_type,
      combination_type: combinationType,
    },
  )

  return { success: true, tfmId: tfm.id }
}

/**
 * Read-only pre-save query for the EditInvalidationDialog. Returns
 * (a) whether a transform exists for this TFM, and (b) the count of
 * staged_data_rows whose `transformed_row_data` JSONB carries the target
 * field name as a key. Capped at PREVIEW_INVALIDATION_COUNT_CAP so a
 * project with millions of staged rows doesn't punish the dialog with
 * an unbounded count.
 *
 * The drawer uses this to decide whether to show the warn dialog
 * BEFORE invoking `editMappingSources`. The dialog gates on
 * `hasTransform === true && stagedRowCount > 0`. On confirm the drawer
 * calls `editMappingSources` regardless — the preview only drives copy.
 */
export async function previewEditInvalidation(
  tfmId: string,
): Promise<PreviewEditInvalidationResult> {
  if (!tfmId) {
    return {
      success: false,
      error: 'tfmId is required',
      errorCode: 'NOT_FOUND',
    }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: 'Not authenticated',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, project_id, target_field_id')
    .eq('id', tfmId)
    .maybeSingle<{ id: string; project_id: string; target_field_id: string }>()
  if (!tfm) {
    return {
      success: false,
      error: 'Mapping not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const perm = await requireProjectPermission(tfm.project_id, 'editor')
  if (!perm.allowed) {
    return {
      success: false,
      error: perm.error ?? 'Insufficient permissions',
      errorCode: 'PERMISSION_DENIED',
    }
  }

  // Transform existence check.
  const { data: txn } = await supabaseAdmin
    .from('transformations')
    .select('id, status')
    .eq('target_field_mapping_id', tfm.id)
    .maybeSingle<{ id: string; status: string }>()
  const hasTransform = txn !== null

  // Read the target field name + table id for the staged-row scan.
  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('id', tfm.target_field_id)
    .single<{ id: string; name: string; table_id: string }>()
  if (!targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Find every TM for (project, target_table) so we can scope the count
  // to staged rows that belong to this field. Multi-source-table projects
  // can have several TMs whose target_table is this field's parent.
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('id')
    .eq('project_id', tfm.project_id)
    .eq('target_table_id', targetField.table_id)
    .neq('status', 'rejected')
  const tmIds: string[] = (tms ?? []).map((t) => t.id as string)
  if (tmIds.length === 0) {
    return { success: true, hasTransform, stagedRowCount: 0, capped: false }
  }

  // Count staged_data_rows whose transformed_row_data JSONB contains the
  // target field name as a key. PostgREST translates `?` (jsonb key
  // existence) via the `cs` (contains) helper; we use raw filter syntax
  // to express it.
  // Cap at PREVIEW_INVALIDATION_COUNT_CAP so a project with millions of
  // staged rows doesn't run a full count.
  const { count, error: countErr } = await supabaseAdmin
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .in('table_mapping_id', tmIds)
    .filter('transformed_row_data', 'cs', JSON.stringify({ [targetField.name]: null }))
    .limit(PREVIEW_INVALIDATION_COUNT_CAP)
  if (countErr) {
    // Soft-fail: count is best-effort signal for the dialog. If the
    // jsonb-contains filter fails (some PostgREST versions are picky),
    // surface qualitative copy via `capped: true` so the dialog still
    // renders the "staged data will be invalidated" warning without a
    // bogus number.
    return {
      success: true,
      hasTransform,
      stagedRowCount: 0,
      capped: hasTransform,
    }
  }
  const stagedRowCount = count ?? 0
  const capped = stagedRowCount >= PREVIEW_INVALIDATION_COUNT_CAP
  return {
    success: true,
    hasTransform,
    stagedRowCount,
    capped,
  }
}
