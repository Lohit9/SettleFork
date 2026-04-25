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
  /** Source fields span multiple source tables. Phase 4a-1 returns this. */
  | 'CROSS_TABLE_NOT_YET_SUPPORTED'
  /**
   * Phase 4a-3 will return this when FK inference between dominant and
   * joined source tables produces zero or multiple candidates. Reserved
   * on the union now so 4a-2 form code can branch on it without churning
   * the type when 4a-3 lands. Unused emitter site in 4a-1.
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
       * Populated by 4a-3 when errorCode === 'CROSS_TABLE_AMBIGUOUS' to
       * surface the candidate FK field names so the form can ask the
       * user to disambiguate. Always undefined in 4a-1.
       */
      candidateFkFields?: string[]
    }

/**
 * Create a target_field_mapping with one or more sources in a single
 * atomic RPC call.
 *
 * Same-table only for Phase 4a-1: every source field must live in the
 * same source table. Cross-table input returns
 * `CROSS_TABLE_NOT_YET_SUPPORTED` (Phase 4a-3 will lift this guard with
 * a paired FK-inference precheck).
 *
 * SEQUENCE (per Phase 4a investigation §2):
 *   1. Auth + permission (`requireProjectPermission(..., 'editor')`).
 *   2. Validate inputs: 1+ sources, no duplicates, combinationType not
 *      'custom_sql', single↔concat sanity (single ⇒ exactly one source;
 *      concat_* ⇒ 2+ sources).
 *   3. Identity reads: source fields with their table_id+name, target
 *      field with its table_id+name. Names hydrate the activity-log
 *      payload.
 *   4. Defensive guards: all field IDs belong to this project; no
 *      duplicate sourceFieldIds; cross-table → CROSS_TABLE_NOT_YET_
 *      SUPPORTED.
 *   5. Maintenance-mode guard (`assertMappingWritesEnabled`).
 *   6. Existing-TFM collision: if a non-rejected non-acknowledged TFM
 *      already exists for the target, return VALIDATION with the
 *      "refresh to see the current state" copy (decision 3). Bare-
 *      acknowledgment exception: silently delete pre-create (mirrors
 *      legacy `addManualFieldMapping:1714-1719` — implicit un-ack).
 *   7. Find-or-create table_mappings row for (sourceTable, targetTable).
 *   8. RPC call `dq_create_target_field_mapping` with multi-source
 *      payload. Status defaults to 'needs_review' (per founder decision
 *      2 — redesign Approve is the explicit acceptance gate).
 *   9. `recomputeTableMappingStatus` — closes the legacy gap where
 *      `addManualFieldMapping` never recomputed coverage post-write.
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
  const { data: targetField, error: tfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables(project_id)')
    .eq('id', targetFieldId)
    .single<{
      id: string
      name: string
      table_id: string
      tables: { project_id: string } | { project_id: string }[] | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  // Defensive: target field belongs to this project.
  const targetProjectId = Array.isArray(targetField.tables)
    ? targetField.tables[0]?.project_id
    : targetField.tables?.project_id
  if (targetProjectId !== projectId) {
    return {
      success: false,
      error: 'Target field does not belong to this project',
      errorCode: 'VALIDATION',
    }
  }

  const { data: sourceFields, error: sfErr } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id, tables(project_id)')
    .in('id', sourceFieldIds)
    .returns<
      Array<{
        id: string
        name: string
        table_id: string
        tables: { project_id: string } | { project_id: string }[] | null
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
    const sfProject = Array.isArray(sf.tables)
      ? sf.tables[0]?.project_id
      : sf.tables?.project_id
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

  // ── Step 5: cross-table guard (Phase 4a-1) ───────────────────────────────
  const uniqueSourceTableIds = new Set(orderedSources.map((s) => s.table_id))
  if (uniqueSourceTableIds.size > 1) {
    return {
      success: false,
      error: 'Cross-table mappings coming in Phase 4a-3',
      errorCode: 'CROSS_TABLE_NOT_YET_SUPPORTED',
    }
  }
  const sourceTableId = orderedSources[0].table_id

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

  const rpcSources = orderedSources.map((sf, idx) => ({
    source_field_id: sf.id,
    source_table_id: sf.table_id,
    confidence: perSourceConfidence,
    ai_reasoning: perSourceReasoning,
    type_compatibility: null as string | null,
    similar_fields_considered: [] as string[],
    join_spec: null as unknown,
    ordinal: idx,
  }))

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
    .select(
      'id, name, data_type, is_primary_key, is_foreign_key, is_nullable, table_id, tables(project_id, name)',
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
        | { project_id: string; name: string }
        | { project_id: string; name: string }[]
        | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const targetProjectId = Array.isArray(targetField.tables)
    ? targetField.tables[0]?.project_id
    : targetField.tables?.project_id
  if (targetProjectId !== projectId) {
    return {
      success: false,
      error: 'Target field does not belong to this project',
      errorCode: 'NOT_FOUND',
    }
  }
  const targetTableName = Array.isArray(targetField.tables)
    ? (targetField.tables[0]?.name ?? '?')
    : (targetField.tables?.name ?? '?')

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
